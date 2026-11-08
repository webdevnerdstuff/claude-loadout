import { atom, read, update } from 'claude-code';
import type { CommandInfo, EngineInterface, Register } from 'claude-code';

import type {
	PluginInfo,
	SkillProblem,
	SkillEntry,
	StaleOverride,
	OffPlugin,
	SkillFilter,
	SkillScan,
	SkillSource,
	SkillUsage,
} from '../types';
import {
	bodyOf,
	hasFrontmatter,
	linkedFiles,
	parseFrontmatter,
	tokensOf,
} from './frontmatter';

type Overrides = Record<string, unknown>;

type InstalledPlugin = {
	scope?: string;
	installPath?: string;
	projectPath?: string;
	version?: string;
};

type PluginManifest = {
	name?: unknown;
	description?: unknown;
	version?: unknown;
	skills?: unknown;
};

const NO_DESCRIPTION = 'No description in SKILL.md.';
const NO_DESCRIPTION_PROBLEM: SkillProblem = {
	code: 'no-description',
	text: 'No description',
};

const tilde = (path: string, home: string): string =>
	home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;

const isOffIn = (overrides: Overrides, keys: string[]): boolean =>
	keys.some((key) => overrides[key] === 'off');

const NAME_RULE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// What a SKILL.md's own text gets wrong: frontmatter, description, name and
// size. `folderName` is checked against the name where the skill has a folder
// of its own (not an account skill).
const checkSkill = (
	text: string,
	fields: Record<string, string>,
	folderName?: string,
): SkillProblem[] => {
	const problems: SkillProblem[] = [];
	const description = fields.description ?? '';
	const lines = text.split('\n').length;

	if (!hasFrontmatter(text)) {
		problems.push({ code: 'no-frontmatter', text: 'No frontmatter' });
	}
	if (hasFrontmatter(text) && !description)
		problems.push(NO_DESCRIPTION_PROBLEM);
	if (description.length > 1024) {
		problems.push({
			code: 'long-description',
			text: `Description is ${description.length.toLocaleString()} characters (limit 1,024)`,
		});
	}
	if (folderName !== undefined) {
		const name = fields.name || folderName;
		if (!NAME_RULE.test(name) || name.length > 64) {
			problems.push({
				code: 'bad-name',
				text: `Name "${name}" should be lowercase letters, digits and hyphens`,
			});
		}
		if (fields.name && fields.name !== folderName) {
			problems.push({
				code: 'name-mismatch',
				text: `Name "${fields.name}" differs from its folder "${folderName}"`,
			});
		}
	}
	if (description && description.length < 40) {
		problems.push({
			code: 'vague-description',
			text: 'Short description: Claude may not know when to use it',
			isHint: true,
		});
	}
	if (lines > 500) {
		problems.push({
			code: 'long-file',
			text: `SKILL.md is ${lines} lines; aim for under 500`,
			isHint: true,
		});
	}
	if (hasFrontmatter(text) && bodyOf(text).trim() === '') {
		problems.push({
			code: 'empty-body',
			text: 'No instructions under the frontmatter',
			isHint: true,
		});
	}

	return problems;
};

const missingRefs = async (
	$: EngineInterface,
	folder: string,
	text: string,
): Promise<SkillProblem[]> => {
	const missing: string[] = [];
	for (const path of linkedFiles(text)) {
		const isThere = await $.fs
			.exists(`${folder}/${path}`)
			.catch(() => true);
		if (!isThere) missing.push(path);
	}
	if (missing.length === 0) return [];
	const more = missing.length > 1 ? ` and ${missing.length - 1} more` : '';

	return [{ code: 'broken-ref', text: `Missing file ${missing[0]}${more}` }];
};

type DirScan = {
	dir: string;
	source: SkillSource;
	group: string;
	home: string;
	overrides: Overrides;
	overrideKey: (name: string) => string[];
	slash: (name: string) => string;
	skip?: string[];
	reportBroken?: boolean;
};

const scanDir = async (
	$: EngineInterface,
	scan: DirScan,
): Promise<SkillEntry[]> => {
	const entries = await $.fs.list(scan.dir).catch(() => []);
	const found: SkillEntry[] = [];

	for (const entry of entries) {
		if (entry.name.startsWith('.') || scan.skip?.includes(entry.name))
			continue;
		const folder = `${scan.dir}/${entry.name}`;
		const stat = await $.fs
			.stat(folder, { resolve: true })
			.catch(() => undefined);
		const base = {
			id: `${scan.source}:${scan.group}:${entry.name}`,
			source: scan.source,
			group: scan.group,
			isOff: isOffIn(scan.overrides, scan.overrideKey(entry.name)),
		};

		if (!stat && entry.isLink && scan.reportBroken) {
			found.push({
				...base,
				name: entry.name,
				description: 'This folder is a symlink that points nowhere.',
				path: tilde(folder, scan.home),
				folder,
				slash: scan.slash(entry.name),
				problems: [{ code: 'broken-link', text: 'Broken symlink' }],
			});
			continue;
		}
		if (stat?.kind !== 'dir') continue;

		// SKILL.md must be spelled in capitals: a lowercase skill.md reads on a
		// Mac, where names ignore case, and is missed on Linux.
		const inside = await $.fs.list(folder).catch(() => []);
		const lower = inside.find(
			(one) =>
				one.name !== 'SKILL.md' &&
				one.name.toLowerCase() === 'skill.md',
		);
		const hasExact = inside.some((one) => one.name === 'SKILL.md');
		const fileName = hasExact ? 'SKILL.md' : lower?.name;
		const file = `${folder}/${fileName ?? 'SKILL.md'}`;
		const text = fileName
			? await $.fs.read(file).catch(() => undefined)
			: undefined;
		if (typeof text !== 'string') {
			if (!scan.reportBroken) continue;
			found.push({
				...base,
				name: entry.name,
				description:
					'This folder has no SKILL.md, so it is not loaded as a skill.',
				path: tilde(folder, scan.home),
				folder,
				slash: scan.slash(entry.name),
				problems: [{ code: 'no-skill-md', text: 'No SKILL.md' }],
			});
			continue;
		}

		const fields = parseFrontmatter(text);
		const name = fields.name || entry.name;
		const keys = [
			...new Set([
				...scan.overrideKey(name),
				...scan.overrideKey(entry.name),
			]),
		];
		const problems = [
			...(!hasExact && lower
				? [
						{
							code: 'lowercase-file' as const,
							text: `Named ${lower.name}; Claude Code looks for SKILL.md`,
						},
					]
				: []),
			...checkSkill(text, fields, entry.name),
			...(await missingRefs($, folder, text)),
		];

		found.push({
			...base,
			name,
			description: fields.description || NO_DESCRIPTION,
			path: tilde(file, scan.home),
			folder,
			file,
			slash: scan.slash(name),
			linkTarget:
				entry.isLink && stat.realPath
					? tilde(stat.realPath, scan.home)
					: undefined,
			isOff: isOffIn(scan.overrides, keys),
			problems,
			tokens: fields.description
				? tokensOf(`${name} ${fields.description}`)
				: undefined,
			lowercaseFile: !hasExact ? lower?.name : undefined,
		});
	}

	return found.sort((a, b) => a.name.localeCompare(b.name));
};

const readManifest = async (
	$: EngineInterface,
	root: string,
): Promise<PluginManifest> => {
	const raw = await $.fs
		.read(`${root}/.claude-plugin/plugin.json`)
		.catch(() => undefined);
	try {
		return typeof raw === 'string'
			? (JSON.parse(raw) as PluginManifest)
			: {};
	} catch {
		return {};
	}
};

const pluginSkillDirs = (root: string, manifest: PluginManifest): string[] => {
	const declared = Array.isArray(manifest.skills)
		? manifest.skills
		: [manifest.skills];
	const extra = declared
		.filter((one): one is string => typeof one === 'string')
		.map((one) => `${root}/${one.replace(/^\.\//, '').replace(/\/$/, '')}`);

	return [...new Set([`${root}/skills`, ...extra])];
};

/** A skill a disabled plugin ships, by name. */
type OffCopy = { name: string; plugin: OffPlugin };

type PluginRoot = {
	root: string;
	origin: PluginInfo['origin'];
	fallbackName: string;
	version?: string;
	key?: string;
	marketplace?: string;
};

const scanPlugins = async (
	$: EngineInterface,
	home: string,
	projectDir: string,
	overrides: Overrides,
): Promise<{
	skills: SkillEntry[];
	plugins: PluginInfo[];
	offCopies: OffCopy[];
}> => {
	const enabled = ((await $.settings.read({ key: 'enabledPlugins' })) ??
		{}) as Record<string, unknown>;
	const raw = await $.fs
		.read(`${home}/.claude/plugins/installed_plugins.json`)
		.catch(() => '{}');
	let installed: Record<string, InstalledPlugin[]> = {};
	try {
		installed =
			(
				JSON.parse(typeof raw === 'string' ? raw : '{}') as {
					plugins?: Record<string, InstalledPlugin[]>;
				}
			).plugins ?? {};
	} catch {
		installed = {};
	}
	const roots: PluginRoot[] = [];
	const offRoots: PluginRoot[] = [];
	// How many installed plugins each marketplace still serves: removing one
	// is offered with a plugin's uninstall only when that plugin is its last.
	const served = new Map<string, number>();
	for (const key of Object.keys(installed)) {
		const marketplace = key.split('@')[1] ?? '';
		served.set(marketplace, (served.get(marketplace) ?? 0) + 1);
	}

	for (const [key, installs] of Object.entries(installed)) {
		const install = installs.find(
			(one) => one.scope === 'user' || one.projectPath === projectDir,
		);
		if (!install?.installPath) continue;
		const marketplace = key.split('@')[1] ?? '';
		const root: PluginRoot = {
			root: install.installPath,
			origin: 'marketplace',
			fallbackName: key.split('@')[0] ?? key,
			version: install.version,
			key,
			marketplace,
		};
		if (enabled[key] !== true) {
			offRoots.push(root);
			continue;
		}
		roots.push(root);
	}

	// Folders Claude Code loads plugins from directly, as CLAUDE_CODE_PLUGIN_DIRS names them.
	const dirs = ((await $.env.get('CLAUDE_CODE_PLUGIN_DIRS')) ?? '')
		.split(':')
		.filter(Boolean);
	for (const dir of dirs) {
		const root = dir.replace(/^~(?=\/|$)/, home).replace(/\/$/, '');
		roots.push({
			root,
			origin: 'dev folder',
			fallbackName: root.split('/').pop() ?? root,
		});
	}

	const skills: SkillEntry[] = [];
	const plugins: PluginInfo[] = [];

	for (const one of roots) {
		const manifest = await readManifest($, one.root);
		const plugin =
			typeof manifest.name === 'string'
				? manifest.name
				: one.fallbackName;
		if (plugins.some((known) => known.name === plugin)) continue;
		const found: SkillEntry[] = [];
		for (const dir of pluginSkillDirs(one.root, manifest)) {
			found.push(
				...(await scanDir($, {
					dir,
					source: 'plugin',
					group: plugin,
					home,
					overrides,
					overrideKey: (name) => [`${plugin}:${name}`],
					slash: (name) => `/${plugin}:${name}`,
				})),
			);
		}
		const from = one.marketplace
			? `${plugin} plugin · ${one.marketplace} marketplace`
			: `${plugin} plugin · dev folder`;
		skills.push(...found.map((skill) => ({ ...skill, origin: from })));
		plugins.push({
			name: plugin,
			origin: one.origin,
			marketplace: one.marketplace,
			path: tilde(one.root, home),
			version:
				typeof manifest.version === 'string'
					? manifest.version
					: one.version,
			description:
				typeof manifest.description === 'string'
					? manifest.description
					: undefined,
			skillCount: found.length,
			commandCount: 0,
		});
	}

	// Skills that disabled plugins ship: listed nowhere, but a local skill of
	// the same name is easy to mistake for one of them.
	const offCopies: OffCopy[] = [];
	for (const one of offRoots) {
		const manifest = await readManifest($, one.root);
		const plugin =
			typeof manifest.name === 'string'
				? manifest.name
				: one.fallbackName;
		for (const dir of pluginSkillDirs(one.root, manifest)) {
			const found = await scanDir($, {
				dir,
				source: 'plugin',
				group: plugin,
				home,
				overrides: {},
				overrideKey: (name) => [name],
				slash: (name) => `/${plugin}:${name}`,
			});
			const off: OffPlugin = {
				name: plugin,
				key: one.key ?? plugin,
				marketplace: one.marketplace ?? '',
				isLastFromMarketplace: served.get(one.marketplace ?? '') === 1,
			};
			offCopies.push(
				...found.map((skill) => ({ name: skill.name, plugin: off })),
			);
		}
	}

	return {
		skills,
		plugins: plugins.sort((a, b) => a.name.localeCompare(b.name)),
		offCopies,
	};
};

type SyncedManifest = {
	lastUpdated?: unknown;
	skills?: Array<{
		name?: unknown;
		description?: unknown;
		enabled?: unknown;
	}>;
};

// The desktop app's own, current copy of the claude.ai account skills (an
// internal folder, not a documented one): each skill carries `enabled`.
const scanSynced = async (
	$: EngineInterface,
	home: string,
	overrides: Overrides,
): Promise<{ skills: SkillEntry[]; syncedAt?: number }> => {
	const root = `${home}/Library/Application Support/Claude/local-agent-mode-sessions/skills-plugin`;
	const found: SkillEntry[] = [];
	let syncedAt: number | undefined;

	for (const org of await $.fs.list(root).catch(() => [])) {
		if (org.kind !== 'dir') continue;
		for (const account of await $.fs
			.list(`${root}/${org.name}`)
			.catch(() => [])) {
			if (account.kind !== 'dir') continue;
			const base = `${root}/${org.name}/${account.name}`;
			const raw = await $.fs
				.read(`${base}/manifest.json`)
				.catch(() => undefined);
			let manifest: SyncedManifest = {};
			try {
				manifest =
					typeof raw === 'string'
						? (JSON.parse(raw) as SyncedManifest)
						: {};
			} catch {
				manifest = {};
			}
			if (typeof manifest.lastUpdated === 'number')
				syncedAt = Math.max(syncedAt ?? 0, manifest.lastUpdated);

			for (const skill of manifest.skills ?? []) {
				if (skill.enabled !== true || typeof skill.name !== 'string')
					continue;
				const file = `${base}/skills/${skill.name}/SKILL.md`;
				const text = await $.fs.read(file).catch(() => undefined);
				const fields =
					typeof text === 'string' ? parseFrontmatter(text) : {};
				const listed =
					typeof skill.description === 'string'
						? skill.description
						: '';
				const description = fields.description || listed;

				found.push({
					id: `synced:${account.name}:${skill.name}`,
					name: skill.name,
					description: description || NO_DESCRIPTION,
					source: 'synced',
					group: 'claude.ai account',
					path: tilde(file, home),
					file: typeof text === 'string' ? file : undefined,
					slash: `/anthropic-skills:${skill.name}`,
					isOff: isOffIn(overrides, [
						`anthropic-skills:${skill.name}`,
					]),
					problems:
						typeof text === 'string'
							? checkSkill(text, fields)
							: description
								? []
								: [NO_DESCRIPTION_PROBLEM],
					tokens: description
						? tokensOf(`${skill.name} ${description}`)
						: undefined,
				});
			}
		}
	}

	return {
		skills: found.sort((a, b) => a.name.localeCompare(b.name)),
		syncedAt,
	};
};

const SOURCE_LABEL: Record<SkillSource, string> = {
	user: 'Local',
	project: 'Project',
	plugin: 'Plugin',
	synced: 'Synced',
};

const placeOf = (skill: SkillEntry): string =>
	skill.source === 'plugin'
		? `${skill.group} plugin`
		: SOURCE_LABEL[skill.source];

// Flags a name that more than one source provides: which one runs is not
// obvious, and a copy may be stale.
const flagDuplicates = (
	skills: SkillEntry[],
	offCopies: OffCopy[] = [],
): SkillEntry[] => {
	const byName = new Map<string, SkillEntry[]>();
	for (const skill of skills) {
		const key = skill.name.toLowerCase();
		byName.set(key, [...(byName.get(key) ?? []), skill]);
	}

	return skills.map((skill) => {
		const others = (byName.get(skill.name.toLowerCase()) ?? []).filter(
			(one) => one.id !== skill.id,
		);
		const offMatches = offCopies.filter(
			(copy) =>
				copy.name.toLowerCase() === skill.name.toLowerCase() &&
				!(
					skill.source === 'plugin' &&
					skill.group === copy.plugin.name
				),
		);
		const offPlaces = offMatches.map(
			(copy) => `${copy.plugin.name} plugin (off)`,
		);
		if (others.length === 0 && offPlaces.length === 0) return skill;
		const places = [
			...new Set([...others.map(placeOf), ...offPlaces]),
		].join(', ');

		const duplicate: SkillProblem = {
			code: 'duplicate',
			text: `Also in ${places}`,
		};

		return {
			...skill,
			problems: [...skill.problems, duplicate],
			offPlugin: offMatches[0]?.plugin,
		};
	});
};

// A plugin's slash commands, as the engine lists them: the ones a mod
// registers in code are in no file. A skill is listed as a command too, so
// the plugin's own skills are left out.
const commandsOf = (
	listed: CommandInfo[],
	plugin: PluginInfo,
	skills: SkillEntry[],
): SkillEntry[] => {
	const own = new Set(
		skills
			.filter((skill) => skill.group === plugin.name)
			.flatMap((skill) => [skill.name, `${plugin.name}:${skill.name}`]),
	);

	return listed
		.filter(
			(command) =>
				command.source === 'plugin' &&
				command.plugin === plugin.name &&
				!own.has(command.name),
		)
		.map((command) => ({
			id: `command:${plugin.name}:${command.name}`,
			name: `/${command.name}`,
			description: command.description || 'No description.',
			source: 'plugin' as const,
			group: plugin.name,
			path: '',
			slash: `/${command.name}`,
			isOff: false,
			problems: [],
			kind: 'command' as const,
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
};

// A bare `/name` skill whose name a built-in command already has.
const flagShadowed = (
	skills: SkillEntry[],
	builtins: Set<string>,
): SkillEntry[] =>
	skills.map((skill) => {
		const isBare = ['user', 'project'].includes(skill.source);
		if (!isBare || !builtins.has(skill.name)) return skill;
		const shadowed: SkillProblem = {
			code: 'shadowed',
			text: `/${skill.name} is also a built-in command`,
		};

		return { ...skill, problems: [...skill.problems, shadowed] };
	});

// `skillOverrides` keys naming no skill found: `name`, `<plugin>:<name>` or
// `anthropic-skills:<name>`, as each skill's command spells it.
const staleIn = (
	overrides: Overrides,
	skills: SkillEntry[],
): StaleOverride[] => {
	const known = new Set(
		skills.flatMap((skill) => [skill.name, skill.slash.slice(1)]),
	);

	return Object.entries(overrides)
		.filter(([key]) => !known.has(key))
		.map(([key, value]) => ({ key, value: String(value) }));
};

type SkillLock = {
	skills?: Record<string, { source?: unknown; installedAt?: unknown }>;
};

// Says where a Local or Project skill came from: `npx skills` records what it
// installs in ~/.agents/.skill-lock.json and links it in from ~/.agents/skills.
const withOrigin = (
	skill: SkillEntry,
	lock: SkillLock,
	home: string,
): SkillEntry => {
	const folderName = skill.folder?.slice(skill.folder.lastIndexOf('/') + 1);
	const fromAgents = skill.linkTarget?.startsWith('~/.agents/skills/');
	const isOwn = skill.source === 'user' || skill.source === 'project';
	const lockName = [folderName, skill.name].find(
		(name) => name !== undefined && lock.skills?.[name] !== undefined,
	);
	const entry = lockName ? lock.skills?.[lockName] : undefined;
	if (isOwn && lockName && entry && (fromAgents || !skill.linkTarget)) {
		const source =
			typeof entry.source === 'string' ? entry.source : 'unknown';
		const at =
			typeof entry.installedAt === 'string'
				? ` · ${new Date(entry.installedAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`
				: '';

		return {
			...skill,
			npxName: lockName,
			origin: `npx skills · ${source}${at}`,
		};
	}
	if (skill.linkTarget)
		return { ...skill, origin: 'A link to a folder elsewhere' };
	if (skill.source === 'synced')
		return { ...skill, origin: 'Your claude.ai account' };
	if (skill.source === 'user')
		return { ...skill, origin: 'Made in your skills folder' };

	return skill;
};

const scanSkills = async ($: EngineInterface): Promise<SkillScan> => {
	const home = (await $.env.get('HOME')) ?? '';
	const projectDir = await $.session.root();
	const loaded = ((await $.settings.read({ key: 'skillOverrides' })) ??
		{}) as Overrides;
	// Entries Loadout just removed from a settings file stay in Claude Code's
	// loaded settings until the app reloads the file: count them as gone, and
	// forget each one once the loaded settings agree.
	const removed = await read($, cleared);
	const pending = removed.filter((key) => key in loaded);
	if (pending.length !== removed.length)
		await update($, cleared, () => pending);
	// The same for entries Loadout just wrote: count them as "off" until the
	// loaded settings have them too.
	const written = await read($, turnedOff);
	const waitingOff = written.filter((key) => !(key in loaded));
	if (waitingOff.length !== written.length)
		await update($, turnedOff, () => waitingOff);
	const overrides = {
		...Object.fromEntries(
			Object.entries(loaded).filter(([key]) => !pending.includes(key)),
		),
		...Object.fromEntries(waitingOff.map((key) => [key, 'off'])),
	} as Overrides;
	const userDir = `${home}/.claude/skills`;

	const user = await scanDir($, {
		dir: userDir,
		source: 'user',
		group: 'user',
		home,
		overrides,
		overrideKey: (name) => [name],
		slash: (name) => `/${name}`,
		skip: ['synced'],
		reportBroken: true,
	});
	const project = await scanDir($, {
		dir: `${projectDir}/.claude/skills`,
		source: 'project',
		group: 'project',
		home,
		overrides,
		overrideKey: (name) => [name],
		slash: (name) => `/${name}`,
		reportBroken: true,
	});
	const plugins = await scanPlugins($, home, projectDir, overrides);
	const synced = await scanSynced($, home, overrides);
	const listed = await $.command.list().catch(() => []);
	const commands = plugins.plugins.flatMap((plugin) =>
		commandsOf(listed, plugin, plugins.skills),
	);
	const builtins = new Set(
		listed
			.filter((command) => command.source === 'builtin')
			.map((command) => command.name),
	);

	const lock = await $.fs
		.read(`${home}/.agents/.skill-lock.json`)
		.then((raw) => JSON.parse(String(raw)) as SkillLock)
		.catch((): SkillLock => ({}));
	const skills = flagShadowed(
		flagDuplicates(
			[
				...[...user, ...project, ...synced.skills].map((skill) =>
					withOrigin(skill, lock, home),
				),
				...plugins.skills,
			],
			plugins.offCopies,
		),
		builtins,
	);

	return {
		skills,
		staleOverrides: [...staleIn(overrides, skills)],
		isMac: await $.process
			.run(['uname'])
			.then((result) => result.stdout.trim() === 'Darwin')
			.catch(() => false),
		plugins: plugins.plugins.map((plugin) => ({
			...plugin,
			commandCount: commands.filter(
				(command) => command.group === plugin.name,
			).length,
		})),
		commands,
		syncedAt: synced.syncedAt,
		userDir: tilde(userDir, home),
		projectDir: tilde(projectDir, home),
		scannedAt: Date.now(),
	};
};

const PANE = 'loadout';
const TITLE = 'Loadout';
const USAGE_KEY = 'usage';

const scan = atom({ plugin: 'loadout', key: 'scan' } as const, null, {
	shape: 'scan-11',
});
const filter = atom({ plugin: 'loadout', key: 'filter' } as const, 'local', {
	shape: 'filter-1',
});
const open = atom({ plugin: 'loadout', key: 'open' } as const, [], {
	shape: 'open-1',
});
const usage = atom(
	{ plugin: 'loadout', key: 'usage' } as const,
	{},
	{ shape: 'usage-1' },
);
// The id of the skill whose Remove link waits for its second click.
const confirm = atom({ plugin: 'loadout', key: 'confirm' } as const, '', {
	shape: 'confirm-1',
});
// skillOverrides entries removed from a file that Claude Code's loaded
// settings may still hold.
const cleared = atom({ plugin: 'loadout', key: 'cleared' } as const, [], {
	shape: 'cleared-1',
});
// What an action just did, drawn at the top of the pane instead of a toast
// (a toast carries the plugin's lowercase name). It clears after a while.
const notice = atom({ plugin: 'loadout', key: 'notice' } as const, null, {
	shape: 'notice-1',
});

const say = async ($: EngineInterface, text: string): Promise<void> => {
	const at = Date.now();
	await update($, notice, () => ({
		text,
		isError:
			/^(Could|Couldn't|No settings file)/.test(text) ||
			/ doesn't parse/.test(text),
		at,
	}));
	$.clock.after(6000, () => {
		void update($, notice, (shown) => (shown?.at === at ? null : shown));
	});
};

// skillOverrides entries Loadout just set to "off" that Claude Code's loaded
// settings may not have yet.
const turnedOff = atom({ plugin: 'loadout', key: 'turnedOff' } as const, [], {
	shape: 'turned-off-1',
});

// The desktop draws some theme keys (merged, warning) and leaves others grey,
// so the sources it would not color use fixed colors that read on light and
// dark alike.
const SOURCE_COLOR: Record<SkillSource, string> = {
	user: '#4c9aff',
	project: '#3fb950',
	plugin: 'merged',
	synced: '#e8853d',
};

const rescan = async ($: EngineInterface): Promise<void> => {
	const result: SkillScan = await scanSkills($);
	await update($, scan, () => result);
};

// Asks in Claude Code's own question dialog before an action that removes
// something, and runs it on the confirming answer. The dialog refuses at once
// where it cannot open (a turn in flight, no surface for it); then the row
// falls back to its inline confirm and Cancel. A refusal that comes later is
// the person closing the dialog, which cancels.
const confirmThen = async (
	$: EngineInterface,
	ask: {
		key: string;
		question: string;
		ok: string;
		run: () => Promise<void>;
	},
): Promise<void> => {
	const startedAt = Date.now();
	try {
		const answer = await $.ui.ask(ask.question, {
			options: [ask.ok, 'Cancel'],
			header: 'Loadout',
		});
		if (answer === ask.ok) await ask.run();
	} catch {
		if (Date.now() - startedAt < 400) {
			await update($, confirm, () => ask.key);
		}
	}
};

const deleteQuestion = (
	skill: SkillEntry,
): { question: string; ok: string } => {
	if (skill.npxName) {
		return {
			question: `Uninstall ${skill.name} (its files go to the Trash; other tools' shortcuts to it stop working)?`,
			ok: 'Uninstall',
		};
	}
	if (skill.linkTarget) {
		return {
			question: `Delete the shortcut ${skill.name} (the folder it points to stays)?`,
			ok: 'Delete shortcut',
		};
	}

	return {
		question: `Move ${skill.name} to the Trash (you can put it back from there)?`,
		ok: 'Move to Trash',
	};
};

const toggle = async ($: EngineInterface, id: string): Promise<void> => {
	// Opening or closing anything drops a confirm waiting for its second click.
	await update($, confirm, () => '');
	await update($, open, (list) =>
		list.includes(id) ? list.filter((one) => one !== id) : [...list, id],
	);
};

const loadUsage = async ($: EngineInterface): Promise<void> => {
	const stored = await $.store.get(USAGE_KEY);
	const value =
		stored && typeof stored === 'object' ? (stored as SkillUsage) : {};
	await update($, usage, () => value);
};

const countUse = async ($: EngineInterface, skill: string): Promise<void> => {
	const stored = await $.store.get(USAGE_KEY);
	const current =
		stored && typeof stored === 'object' ? (stored as SkillUsage) : {};
	const before = current[skill];
	const next: SkillUsage = {
		...current,
		[skill]: { count: (before?.count ?? 0) + 1, last: Date.now() },
	};
	await $.store.set(USAGE_KEY, next);
	await update($, usage, () => next);
};

const openFile = async ($: EngineInterface, file: string): Promise<void> => {
	const code = await $.process
		.run(['open', '-a', 'Visual Studio Code', file])
		.then((result) => result.exitCode)
		.catch(() => 1);
	if (code === 0) return;
	const fallback = await $.process
		.run(['open', '-t', file])
		.then((result) => result.exitCode)
		.catch(() => 1);
	if (fallback !== 0) void $.ui.toast(`Could not open ${file}`);
};

// Puts `/name ` at the start of the prompt box, keeping the draft after it
// (a draft that already starts with a slash command has that command swapped).
// Never sends. Falls back to the clipboard where no box takes the text.
type CopySurface = Parameters<EngineInterface['ui']['copy']>[0]['surface'];

const insertCommand = async (
	$: EngineInterface,
	slash: string,
	surface: CopySurface,
): Promise<void> => {
	const box = await $.prompt.read();
	const rest = box.text.replace(/^\/\S+\s*/, '').trim();
	const text = rest ? `${slash} ${rest}` : `${slash} `;
	const filled = await $.prompt
		.fill({ text, mode: 'replace' })
		.catch(() => undefined);
	if (filled?.isFilled) return;
	await $.ui.copy({ text: slash, surface }).catch(() => undefined);
	void say(
		$,
		`Couldn't reach the prompt box, so ${slash} was copied instead`,
	);
};

const parentOf = (path: string): string =>
	path.slice(0, path.lastIndexOf('/')) || '/';

// Shows the item selected in Finder; a broken link Finder cannot select, so
// its folder opens instead.
const reveal = async ($: EngineInterface, path: string): Promise<void> => {
	const code = await $.process
		.run(['open', '-R', path])
		.then((result) => result.exitCode)
		.catch(() => 1);
	if (code === 0) return;
	await $.process.run(['open', parentOf(path)]).catch(() => undefined);
};

// Deletes the symlink itself and nothing it points to: it is checked to be a
// link first, and `rm` without `-r` cannot remove a folder.
const removeLink = async ($: EngineInterface, path: string): Promise<void> => {
	await update($, confirm, () => '');
	const name = path.slice(path.lastIndexOf('/') + 1);
	const entries = await $.fs.list(parentOf(path)).catch(() => []);
	const isLink = entries.some((entry) => entry.name === name && entry.isLink);
	if (!isLink) {
		void say($, `${name} is not a symlink, so it was left alone`);
		return;
	}
	const result = await $.process.run(['rm', path]).catch(() => undefined);
	void say(
		$,
		result?.exitCode === 0
			? `Removed the link ${name}`
			: `Could not remove ${name}`,
	);
	await rescan($);
};

// The `skillOverrides` keys a skill can be listed under: its command without
// the slash (`name`, `<plugin>:<name>`, `anthropic-skills:<name>`) and its name.
const overrideKeysOf = (skill: SkillEntry): string[] => [
	...new Set([skill.slash.slice(1), skill.name]),
];

// Removes `keys` from `skillOverrides` in every settings file that has them:
// the user's, the project's and the project's local one. Only those entries
// change: the rest of the file, its key order and its indentation stay, and
// what is written is read back and parsed before it counts. The file's text
// never leaves this function: it is not logged, stored or shown.
const removeOverrides = async (
	$: EngineInterface,
	keys: string[],
): Promise<number> => {
	const home = (await $.env.get('HOME')) ?? '';
	const root = await $.session.root();
	const files = [
		`${home}/.claude/settings.json`,
		`${root}/.claude/settings.json`,
		`${root}/.claude/settings.local.json`,
	];
	let removed = 0;

	for (const file of [...new Set(files)]) {
		const raw = await $.fs.read(file).catch(() => undefined);
		if (typeof raw !== 'string') continue;
		let settings: { skillOverrides?: Record<string, unknown> };
		try {
			settings = JSON.parse(raw) as typeof settings;
		} catch {
			continue;
		}
		const overrides = settings.skillOverrides;
		if (!overrides || typeof overrides !== 'object') continue;
		const found = keys.filter((key) => key in overrides);
		if (found.length === 0) continue;
		for (const key of found) delete overrides[key];

		const indent = /\n([ \t]+)"/.exec(raw)?.[1] ?? '  ';
		const text = `${JSON.stringify(settings, null, indent)}${raw.endsWith('\n') ? '\n' : ''}`;
		await $.fs.write(file, text);
		const check = await $.fs.read(file).catch(() => undefined);
		let isWritten = false;
		try {
			isWritten = typeof check === 'string' && Boolean(JSON.parse(check));
		} catch {
			isWritten = false;
		}
		if (!isWritten) {
			await $.fs.write(file, raw);
			void say(
				$,
				`Could not update ${tilde(file, home)}; it was left as it was`,
			);
			continue;
		}
		removed += found.length;
		await update($, cleared, (list) => [...new Set([...list, ...found])]);
		await update($, turnedOff, (list) =>
			list.filter((key) => !found.includes(key)),
		);
	}

	return removed;
};

// Turns a skill off: sets its key to "off" in skillOverrides of the user's
// settings, ~/.claude/settings.json, as Claude Code's /skills does. Only that
// entry changes; the file keeps its key order and indentation, is read back
// and parsed, and is restored if that fails. Its text never leaves here.
const turnSkillOff = async (
	$: EngineInterface,
	skill: SkillEntry,
): Promise<void> => {
	const home = (await $.env.get('HOME')) ?? '';
	const file = `${home}/.claude/settings.json`;
	const key = skill.slash.slice(1);
	const raw = await $.fs.read(file).catch(() => undefined);
	const before = typeof raw === 'string' ? raw : '{}\n';
	let settings: { skillOverrides?: Record<string, unknown> };
	try {
		settings = JSON.parse(before) as typeof settings;
	} catch {
		void say($, `${tilde(file, home)} doesn't parse, so it was left alone`);
		return;
	}
	settings.skillOverrides = {
		...(settings.skillOverrides ?? {}),
		[key]: 'off',
	};
	const indent = /\n([ \t]+)"/.exec(before)?.[1] ?? '  ';
	await $.fs.write(file, `${JSON.stringify(settings, null, indent)}\n`);
	const check = await $.fs.read(file).catch(() => undefined);
	let isWritten = false;
	try {
		isWritten = typeof check === 'string' && Boolean(JSON.parse(check));
	} catch {
		isWritten = false;
	}
	if (!isWritten) {
		if (typeof raw === 'string') await $.fs.write(file, raw);
		void say(
			$,
			`Could not update ${tilde(file, home)}; it was left as it was`,
		);
		return;
	}
	await update($, turnedOff, (list) => [...new Set([...list, key])]);
	await update($, cleared, (list) => list.filter((one) => one !== key));
	void say($, `Turned ${skill.name} off`);
	await rescan($);
};

// Turns a skill back on by removing its "off" entry from skillOverrides.
const turnSkillOn = async (
	$: EngineInterface,
	skill: SkillEntry,
): Promise<void> => {
	const removed = await removeOverrides($, overrideKeysOf(skill));
	void say(
		$,
		removed > 0
			? `Turned ${skill.name} on`
			: `No settings file had ${skill.name} turned off`,
	);
	await rescan($);
};

const removeStale = async ($: EngineInterface, key: string): Promise<void> => {
	const removed = await removeOverrides($, [key]);
	void say(
		$,
		removed > 0
			? `Removed "${key}" from skillOverrides`
			: `"${key}" was not found`,
	);
	await rescan($);
};

// Runs a command on the Mac; where it cannot start or fails (a desktop app's
// PATH may not reach a tool a terminal does), copies it for a terminal instead.
// The Claude Code programs to try, newest first: the copy the desktop app
// ships (no PATH or separate install needed), then `claude` on the PATH.
const claudeCommands = async ($: EngineInterface): Promise<string[]> => {
	const home = (await $.env.get('HOME')) ?? '';
	const root = `${home}/Library/Application Support/Claude/claude-code`;
	const newer = (a: string, b: string): number => {
		const [x, y] = [a, b].map((v) =>
			v.split('.').map((n) => Number(n) || 0),
		);
		for (let i = 0; i < 3; i++) {
			const diff = (y?.[i] ?? 0) - (x?.[i] ?? 0);
			if (diff !== 0) return diff;
		}

		return 0;
	};
	const versions = (await $.fs.list(root).catch(() => []))
		.filter((one) => one.kind === 'dir' && /^\d+\.\d+\.\d+$/.test(one.name))
		.map((one) => one.name)
		.sort(newer);
	const bundled: string[] = [];
	for (const version of versions) {
		for (const build of await $.fs
			.list(`${root}/${version}`)
			.catch(() => [])) {
			const program = `${root}/${version}/${build.name}/claude.app/Contents/MacOS/claude`;
			if (await $.fs.exists(program).catch(() => false))
				bundled.push(program);
		}
	}

	return [...bundled, 'claude'];
};

// Runs a `claude …` command with the first Claude Code program that starts.
const runClaude = async (
	$: EngineInterface,
	args: string[],
	surface: CopySurface,
): Promise<boolean> => {
	for (const program of await claudeCommands($)) {
		const result = await $.process
			.run([program, ...args], { timeoutMs: 120000 })
			.catch(() => undefined);
		if (result?.exitCode === 0) return true;
		// It started and refused: another copy would refuse the same way.
		if (result !== undefined && program !== 'claude') break;
	}

	return runOrCopy($, ['claude', ...args], surface);
};

const runOrCopy = async (
	$: EngineInterface,
	argv: string[],
	surface: CopySurface,
): Promise<boolean> => {
	const result = await $.process
		.run(argv, { timeoutMs: 120000 })
		.catch(() => undefined);
	if (result?.exitCode === 0) return true;
	const typed = argv
		.map((part) => (/^[\w@./:-]+$/.test(part) ? part : `'${part}'`))
		.join(' ');
	await $.ui.copy({ text: typed, surface }).catch(() => undefined);
	void $.ui.toast(
		`Couldn't run it from Claude, so it's copied: paste it in a terminal`,
	);

	return false;
};

const uninstallPlugin = async (
	$: EngineInterface,
	plugin: OffPlugin,
	surface: CopySurface,
): Promise<void> => {
	await update($, confirm, () => '');
	const isRemoved = await runClaude(
		$,
		['plugin', 'uninstall', plugin.key],
		surface,
	);
	if (isRemoved && plugin.isLastFromMarketplace && plugin.marketplace) {
		await runClaude(
			$,
			['plugin', 'marketplace', 'remove', plugin.marketplace],
			surface,
		);
	}
	if (isRemoved) {
		void say(
			$,
			plugin.isLastFromMarketplace
				? `Uninstalled ${plugin.name} and removed the ${plugin.marketplace} marketplace`
				: `Uninstalled ${plugin.name}`,
		);
	}
	await rescan($);
};

// Uninstalls a skill `npx skills` installed, without needing Node: its shared
// folder in ~/.agents/skills moves to the Trash, Claude Code's shortcut to it
// is deleted, and its entry leaves npx skills' lock file. Other tools'
// shortcuts to the folder, if any, are left and point nowhere.
const uninstallNpxSkill = async (
	$: EngineInterface,
	skill: SkillEntry,
	name: string,
): Promise<void> => {
	await update($, confirm, () => '');
	const home = (await $.env.get('HOME')) ?? '';
	if (!home) return;
	const shared = `${home}/.agents/skills/${name}`;
	const sharedEntry = (
		await $.fs.list(`${home}/.agents/skills`).catch(() => [])
	).find((one) => one.name === name);
	let isTrashed = false;
	if (sharedEntry && !sharedEntry.isLink) {
		const isTaken = await $.fs
			.exists(`${home}/.Trash/${name}`)
			.catch(() => true);
		const target = `${home}/.Trash/${isTaken ? `${name} ${Date.now()}` : name}`;
		const moved = await $.process
			.run(['mv', '-n', shared, target])
			.catch(() => undefined);
		isTrashed = moved?.exitCode === 0;
		if (!isTrashed) {
			void say(
				$,
				`Could not move ${name} to the Trash; nothing was changed`,
			);
			await rescan($);
			return;
		}
	}

	// Claude Code's shortcut: removed only when it is a link.
	const folder = skill.folder ?? '';
	const linkName = folder.slice(folder.lastIndexOf('/') + 1);
	const isLink = (await $.fs.list(parentOf(folder)).catch(() => [])).some(
		(one) => one.name === linkName && one.isLink,
	);
	if (folder && isLink)
		await $.process.run(['rm', folder]).catch(() => undefined);

	// npx skills' record of the install: only this skill's entry changes.
	const lockFile = `${home}/.agents/.skill-lock.json`;
	const raw = await $.fs.read(lockFile).catch(() => undefined);
	if (typeof raw === 'string') {
		try {
			const lock = JSON.parse(raw) as {
				skills?: Record<string, unknown>;
			};
			if (lock.skills && name in lock.skills) {
				delete lock.skills[name];
				const indent = /\n([ \t]+)"/.exec(raw)?.[1] ?? '  ';
				await $.fs.write(
					lockFile,
					`${JSON.stringify(lock, null, indent)}${raw.endsWith('\n') ? '\n' : ''}`,
				);
			}
		} catch {
			// A lock file that does not parse is left as it is.
		}
	}

	await removeOverrides($, overrideKeysOf(skill));
	void say(
		$,
		isTrashed
			? `Uninstalled ${name}: its files are in the Trash`
			: `Uninstalled ${name}`,
	);
	await rescan($);
};

// Deletes a skill that is off, recoverably: a symlink loses only the link (its
// target stays), a folder moves to the macOS Trash under a name not taken.
// Its "off" entry goes with it, so nothing is left behind in the settings.
const deleteSkill = async (
	$: EngineInterface,
	folder: string,
	keys: string[],
): Promise<void> => {
	await update($, confirm, () => '');
	const name = folder.slice(folder.lastIndexOf('/') + 1);
	const entry = (await $.fs.list(parentOf(folder)).catch(() => [])).find(
		(one) => one.name === name,
	);
	if (!entry) {
		await rescan($);
		return;
	}
	if (entry.isLink) {
		const result = await $.process
			.run(['rm', folder])
			.catch(() => undefined);
		if (result?.exitCode === 0) await removeOverrides($, keys);
		void say(
			$,
			result?.exitCode === 0
				? `Removed the link ${name}; the folder it pointed to is untouched`
				: `Could not remove ${name}`,
		);
		await rescan($);
		return;
	}
	const home = (await $.env.get('HOME')) ?? '';
	const isTaken = await $.fs
		.exists(`${home}/.Trash/${name}`)
		.catch(() => true);
	const target = `${home}/.Trash/${isTaken ? `${name} ${Date.now()}` : name}`;
	const result = home
		? await $.process
				.run(['mv', '-n', folder, target])
				.catch(() => undefined)
		: undefined;
	if (result?.exitCode === 0) await removeOverrides($, keys);
	void say(
		$,
		result?.exitCode === 0
			? `Moved ${name} to the Trash`
			: `Could not move ${name} to the Trash`,
	);
	await rescan($);
};

const createSkillFile = async (
	$: EngineInterface,
	folder: string,
	name: string,
): Promise<void> => {
	const file = `${folder}/SKILL.md`;
	if (await $.fs.exists(file).catch(() => false)) {
		void say($, `${name} already has a SKILL.md`);
		await rescan($);
		return;
	}
	const starter = `---\nname: ${name}\ndescription: Say what this skill does and when Claude should use it.\n---\n\n# ${name}\n\nWrite the instructions here.\n`;
	await $.fs.write(file, starter);
	await openFile($, file);
	await rescan($);
};

// Puts a request about a duplicate in the prompt box, after any draft. Never sends.
const askClaude = async (
	$: EngineInterface,
	skill: SkillEntry,
	problem: SkillProblem,
): Promise<void> => {
	const where = skill.path || skill.slash;
	const text = `The skill "${skill.name}" (${where}) is ${problem.text.replace(/^Also in/, 'also in')}. Which copy does Claude Code use, and which should I keep?`;
	const box = await $.prompt.read();
	const filled = await $.prompt
		.fill({
			text: box.text.trim() ? `${box.text}\n\n${text}` : text,
			mode: 'replace',
		})
		.catch(() => undefined);
	if (!filled?.isFilled) void $.ui.toast("Couldn't reach the prompt box");
};

const warningsOf = (skill: SkillEntry): SkillProblem[] =>
	skill.problems.filter((problem) => !problem.isHint);

const hintsOf = (skill: SkillEntry): SkillProblem[] =>
	skill.problems.filter((problem) => problem.isHint);

const addFrontmatter = async (
	$: EngineInterface,
	file: string,
	name: string,
): Promise<void> => {
	const text = await $.fs.read(file).catch(() => undefined);
	if (typeof text !== 'string' || hasFrontmatter(text)) {
		await rescan($);
		return;
	}
	const header = `---\nname: ${name}\ndescription: Say what this skill does and when Claude should use it.\n---\n\n`;
	await $.fs.write(file, `${header}${text}`);
	await openFile($, file);
	await rescan($);
};

// Renames a lowercase skill.md to SKILL.md, through a temporary name so a
// Mac, where names ignore case, takes the change.
const renameSkillFile = async (
	$: EngineInterface,
	folder: string,
	current: string,
): Promise<void> => {
	const temporary = `${folder}/.loadout-rename-${Date.now()}`;
	const first = await $.process
		.run(['mv', '-n', `${folder}/${current}`, temporary])
		.catch(() => undefined);
	const second =
		first?.exitCode === 0
			? await $.process
					.run(['mv', '-n', temporary, `${folder}/SKILL.md`])
					.catch(() => undefined)
			: undefined;
	void say(
		$,
		second?.exitCode === 0
			? `Renamed ${current} to SKILL.md`
			: `Could not rename ${current}`,
	);
	await rescan($);
};

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

const countOff = (skills: SkillEntry[]): number =>
	skills.filter((skill) => skill.isOff).length;

const ago = (when: number): string => {
	const minutes = Math.floor((Date.now() - when) / 60000);
	if (minutes < 1) return 'just now';
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;

	return `${Math.floor(hours / 24)}d ago`;
};

const usageOf = (all: SkillUsage, skill: SkillEntry) =>
	all[skill.slash.slice(1)] ?? all[skill.name];

export const register: Register = (on) => {
	on('session.start', async ($, e, next) => {
		await $.command.register({
			name: 'loadout',
			description:
				'See every skill and plugin Claude Code has equipped, in a pane',
		});
		void loadUsage($);
		void rescan($);

		return next(e);
	});

	on('command.run', { command: 'loadout' }, async ($) => {
		await rescan($);
		await $.ui.open({ id: PANE, title: TITLE });

		return { text: 'Loadout opened.' };
	});

	on('skill.prompt', async ($, e, next) => {
		const result = await next(e);
		await countUse($, e.skill).catch(() => undefined);

		return result;
	});

	on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
		const { Box, Text, Button } = $.ui.resolve(e);
		const data = await read($, scan);
		const expanded = await read($, open);
		const picked = await read($, filter);
		const used = await read($, usage);
		const waiting = await read($, confirm);
		const shownNotice = await read($, notice);

		if (!data) {
			return (
				<Box flexDirection="column" gap={1}>
					<Text dimColor>Reading your skills…</Text>
					<Button label="Refresh" onPress={() => void rescan($)} />
				</Box>
			);
		}

		const has = (skill: SkillEntry, code: SkillProblem['code']) =>
			skill.problems.some((problem) => problem.code === code);

		// A button with a label that shows while the pointer is over it: a
		// hidden Box beside the button, revealed by its keyed wrapper's hover, sized
		// to its text so it never wraps to the button's width. Buttons have no
		// tooltip of their own.
		// What an expanded row offers: Insert for a healthy skill; for a flagged
		// one, the fixes its problems call for instead.
		const actions = (skill: SkillEntry) => {
			const folder = skill.folder ?? '';
			const duplicate = skill.problems.find(
				(problem) => problem.code === 'duplicate',
			);
			// Open: the SKILL.md in VS Code, or the default text editor.
			const edit = skill.file && (
				<Button
					key={`edit:${skill.id}`}
					label="VS Code ↗"
					onPress={() => void openFile($, skill.file ?? '')}
				/>
			);
			const finder = skill.folder && skill.kind !== 'command' && (
				<Button
					key={`reveal:${skill.id}`}
					label="Finder ↗"
					onPress={() => void reveal($, skill.folder ?? '')}
				/>
			);
			// Remove is on every Local and Project skill, and picks the way that
			// undoes how it got there: npx skills, a shortcut, or a real folder.
			const canDelete =
				data.isMac &&
				Boolean(skill.folder) &&
				['user', 'project'].includes(skill.source);
			const deleteKey = `delete:${skill.id}`;
			const remove =
				canDelete &&
				(waiting === deleteKey ? (
					[
						<Button
							key={`confirm-delete:${skill.id}`}
							variant="primary"
							label={
								skill.npxName
									? 'Confirm: uninstall'
									: skill.linkTarget
										? 'Confirm: delete shortcut'
										: 'Confirm: move to Trash'
							}
							onPress={(press) =>
								skill.npxName
									? void uninstallNpxSkill(
											$,
											skill,
											skill.npxName,
										)
									: void deleteSkill(
											$,
											skill.folder ?? '',
											overrideKeysOf(skill),
										)
							}
						/>,
						<Button
							key={`cancel:${skill.id}`}
							label="Cancel"
							onPress={() => void update($, confirm, () => '')}
						/>,
					]
				) : (
					<Button
						key={deleteKey}
						label={
							skill.npxName
								? 'Uninstall'
								: skill.linkTarget
									? 'Delete shortcut'
									: 'Trash'
						}
						onPress={(press) =>
							void confirmThen($, {
								key: deleteKey,
								...deleteQuestion(skill),
								run: () =>
									skill.npxName
										? uninstallNpxSkill(
												$,
												skill,
												skill.npxName,
											)
										: deleteSkill(
												$,
												skill.folder ?? '',
												overrideKeysOf(skill),
											),
							})
						}
					/>
				));
			const turnOff = !skill.isOff &&
				skill.kind !== 'command' &&
				skill.file && (
					<Button
						key={`turn-off:${skill.id}`}
						label="Turn off"
						onPress={() => void turnSkillOff($, skill)}
					/>
				);
			const turnOn = skill.isOff && skill.kind !== 'command' && (
				<Button
					key={`turn-on:${skill.id}`}
					variant="primary"
					label="Turn on"
					onPress={() => void turnSkillOn($, skill)}
				/>
			);
			if (warningsOf(skill).length === 0) {
				// Insert, Open and Finder lead; the actions that change things follow.
				return [
					// A skill that is off cannot run, so it has nothing to insert.
					!skill.isOff && (
						<Button
							key={`insert:${skill.id}`}
							label="Insert"
							onPress={(press) =>
								void insertCommand(
									$,
									skill.slash,
									press.surface,
								)
							}
						/>
					),
					edit,
					finder,
					turnOn,
					turnOff,
					remove,
				]
					.flat()
					.filter(Boolean);
			}

			const folderName = folder.slice(folder.lastIndexOf('/') + 1);
			const writes = (fix: () => Promise<void>) => () => void fix();

			// A flagged skill leads with what fixes it; Open and Finder follow.
			return [
				has(skill, 'no-skill-md') && folder && (
					<Button
						key={`create:${skill.id}`}
						variant="primary"
						label="Create SKILL.md"
						onPress={writes(() =>
							createSkillFile($, folder, skill.name),
						)}
					/>
				),
				has(skill, 'no-frontmatter') && skill.file && (
					<Button
						key={`frontmatter:${skill.id}`}
						variant="primary"
						label="Add frontmatter"
						onPress={writes(() =>
							addFrontmatter($, skill.file ?? '', folderName),
						)}
					/>
				),
				has(skill, 'lowercase-file') && skill.lowercaseFile && (
					<Button
						key={`rename:${skill.id}`}
						variant="primary"
						label="Rename to SKILL.md"
						onPress={writes(() =>
							renameSkillFile(
								$,
								folder,
								skill.lowercaseFile ?? '',
							),
						)}
					/>
				),
				has(skill, 'broken-link') &&
					folder &&
					(waiting === skill.id ? (
						[
							<Button
								key={`confirm-remove:${skill.id}`}
								variant="primary"
								label="Confirm remove"
								onPress={() => void removeLink($, folder)}
							/>,
							<Button
								key={`cancel:${skill.id}`}
								label="Cancel"
								onPress={() =>
									void update($, confirm, () => '')
								}
							/>,
						]
					) : (
						<Button
							key={`remove:${skill.id}`}
							label="Remove link"
							onPress={() =>
								void confirmThen($, {
									key: skill.id,
									question: `Remove the broken shortcut ${skill.name} (nothing else is touched)?`,
									ok: 'Remove link',
									run: () => removeLink($, folder),
								})
							}
						/>
					)),
				skill.offPlugin &&
					(waiting === `uninstall:${skill.id}` ? (
						[
							<Button
								key={`confirm-uninstall:${skill.id}`}
								variant="primary"
								label={
									skill.offPlugin.isLastFromMarketplace
										? `Confirm: uninstall ${skill.offPlugin.name} and its marketplace`
										: `Confirm: uninstall ${skill.offPlugin.name}`
								}
								onPress={(press) =>
									void uninstallPlugin(
										$,
										skill.offPlugin as OffPlugin,
										press.surface,
									)
								}
							/>,
							<Button
								key={`cancel:${skill.id}`}
								label="Cancel"
								onPress={() =>
									void update($, confirm, () => '')
								}
							/>,
						]
					) : (
						<Button
							key={`uninstall:${skill.id}`}
							label={`Uninstall ${skill.offPlugin.name} plugin`}
							onPress={(press) => {
								const plugin = skill.offPlugin as OffPlugin;
								void confirmThen($, {
									key: `uninstall:${skill.id}`,
									question: plugin.isLastFromMarketplace
										? `Uninstall the ${plugin.name} plugin and its ${plugin.marketplace} marketplace (nothing else uses it)?`
										: `Uninstall the ${plugin.name} plugin?`,
									ok: 'Uninstall',
									run: () =>
										uninstallPlugin(
											$,
											plugin,
											press.surface,
										),
								});
							}}
						/>
					)),
				duplicate && (
					<Button
						key={`ask:${skill.id}`}
						label="Ask Claude"
						onPress={() => void askClaude($, skill, duplicate)}
					/>
				),
				edit,
				finder,
				!has(skill, 'broken-link') && turnOn,
				!has(skill, 'broken-link') && turnOff,
				!has(skill, 'broken-link') && remove,
			]
				.flat()
				.filter(Boolean);
		};

		// One labelled line of an expanded skill: a fixed label column, then the
		// value, so file, cost and source read apart.
		const detail = (label: string, value: string, isPath?: boolean) => (
			<Box key={label} flexDirection="row" gap={1}>
				<Box width={7} flexShrink={0}>
					<Text dimColor size="footnote">
						{label}
					</Text>
				</Box>
				<Text size="footnote" mono={isPath} wrap="truncate-end">
					{value}
				</Text>
			</Box>
		);

		const details = (skill: SkillEntry) => {
			const isCosted = skill.tokens !== undefined;
			const cost = skill.isOff
				? `≈ ${skill.tokens} tokens, none while off`
				: `≈ ${skill.tokens} tokens every session`;

			return (
				<Box flexDirection="column" marginTop={1}>
					{skill.path && detail('File', skill.path, true)}
					{isCosted && detail('Cost', cost)}
					{skill.origin && detail('Source', skill.origin)}
				</Box>
			);
		};

		const row = (skill: SkillEntry) => {
			const isOpen = expanded.includes(skill.id);
			const use = usageOf(used, skill);

			return (
				<Box
					key={skill.id}
					flexDirection="column"
					paddingLeft={2}
					marginTop="xs"
				>
					<Box flexDirection="row" alignItems="center" gap={1}>
						<Text
							color={SOURCE_COLOR[skill.source]}
							dimColor={skill.isOff}
						>
							●
						</Text>
						<Button
							key={`row:${skill.id}`}
							plain
							dimColor={skill.isOff}
							onPress={() => void toggle($, skill.id)}
						>
							{`${isOpen ? '▾' : '▸'} ${skill.name}`}
						</Button>
						{skill.isOff && (
							<Text color="error" bold size="caption">
								OFF
							</Text>
						)}
						{warningsOf(skill).length > 0 && (
							<Text color="warning" size="caption">
								⚠ {warningsOf(skill)[0]?.text}
							</Text>
						)}
						{warningsOf(skill).length === 0 &&
							hintsOf(skill).length > 0 && (
								<Text dimColor size="caption">
									ⓘ {hintsOf(skill)[0]?.text}
								</Text>
							)}
						{use && (
							<Text dimColor size="caption">
								{use.count}× · {ago(use.last)}
							</Text>
						)}
					</Box>
					<Box paddingLeft={4} flexDirection="column">
						<Text dimColor wrap={isOpen ? 'wrap' : 'truncate-end'}>
							{isOpen
								? skill.description
								: oneLine(skill.description)}
						</Text>
						{isOpen &&
							skill.problems.map((problem) =>
								problem.isHint ? (
									<Text dimColor size="footnote">
										ⓘ {problem.text}
									</Text>
								) : (
									<Text color="warning" size="footnote">
										⚠ {problem.text}
									</Text>
								),
							)}
						{isOpen && details(skill)}
						{isOpen && (
							<Box
								flexDirection="row"
								flexWrap="wrap"
								gap={1}
								marginTop={1}
							>
								{actions(skill)}
							</Box>
						)}
					</Box>
				</Box>
			);
		};

		// A section's open state lives in the same list as the rows', under
		// `closed:<section>`: sections start open.
		const isClosed = (section: string) =>
			expanded.includes(`closed:${section}`);

		const heading = (
			label: string,
			where: string,
			color: string,
			count: number | string,
			off: number,
			section: string,
		) => (
			<Box
				flexDirection="row"
				justifyContent="space-between"
				alignItems="center"
				marginTop="md"
				paddingX={1}
				backgroundColor="#80808026"
			>
				<Box flexDirection="row" gap={1} alignItems="center">
					<Text color={color}>●</Text>
					<Button
						key={`section:${section}`}
						plain
						onPress={() => void toggle($, `closed:${section}`)}
					>
						{`${isClosed(section) ? '▸' : '▾'} ${label.toUpperCase()}`}
					</Button>
					{where && (
						<Text dimColor size="footnote">
							{where}
						</Text>
					)}
				</Box>
				<Text dimColor size="footnote">
					{off ? `${count} · ${off} off` : `${count}`}
				</Text>
			</Box>
		);

		const fold = (
			id: string,
			label: string,
			skills: SkillEntry[],
			isForced: boolean,
			tags?: string,
			tally?: string,
		) => {
			const isOpen = isForced || expanded.includes(id);
			const issues = skills.filter(
				(skill) => warningsOf(skill).length > 0,
			).length;

			return (
				<Box
					key={id}
					flexDirection="column"
					paddingLeft={2}
					marginTop="xs"
				>
					<Box flexDirection="row" gap={1} alignItems="center">
						{!isForced && (
							<Button
								key={`fold:${id}`}
								plain
								onPress={() => void toggle($, id)}
							>
								{`${isOpen ? '▾' : '▸'} ${label} (${tally ?? skills.length})`}
							</Button>
						)}
						{isForced && (
							<Text>{`▾ ${label} (${tally ?? skills.length})`}</Text>
						)}
						{tags && (
							<Text dimColor size="caption">
								{tags}
							</Text>
						)}
						{!isOpen && issues > 0 && (
							<Text color="warning" size="caption">
								⚠ {issues}
							</Text>
						)}
					</Box>
					{isOpen && skills.map(row)}
				</Box>
			);
		};

		const pluginTags = (plugin: PluginInfo): string =>
			[
				plugin.version ? `v${plugin.version}` : '',
				plugin.origin === 'dev folder' ? 'dev folder' : '',
			]
				.filter(Boolean)
				.join(' · ');

		const plural = (count: number, word: string): string =>
			`${count} ${word}${count === 1 ? '' : 's'}`;

		// A plugin with no skills and no commands (hooks only): listed so the
		// section shows every plugin Claude has loaded.
		const bare = (plugin: PluginInfo) => (
			<Box
				key={`bare:${plugin.name}`}
				flexDirection="row"
				gap={1}
				paddingLeft={2}
				marginTop="xs"
				alignItems="center"
			>
				<Text dimColor>{`  ${plugin.name}`}</Text>
				<Text dimColor size="caption">
					{['no skills or commands', pluginTags(plugin)]
						.filter(Boolean)
						.join(' · ')}
				</Text>
			</Box>
		);

		const note = (text: string) => (
			<Box paddingLeft={2}>
				<Text dimColor>{text}</Text>
			</Box>
		);

		const all = data.skills;
		const isLocal = (skill: SkillEntry) => skill.source !== 'synced';
		const hasIssue = (skill: SkillEntry) => warningsOf(skill).length > 0;
		// What every session pays for the skill listing: each skill that is on.
		const tokenTotal = all
			.filter((skill) => !skill.isOff)
			.reduce((sum, skill) => sum + (skill.tokens ?? 0), 0);
		const stale = data.staleOverrides ?? [];
		const local = all.filter(isLocal);
		const counts: Record<SkillFilter, number> = {
			local: all.length,
			user: all.filter((skill) => skill.source === 'user').length,
			project: all.filter((skill) => skill.source === 'project').length,
			plugin: data.plugins.length,
			off: local.filter((skill) => skill.isOff).length,
			issues: all.filter(hasIssue).length + stale.length,
			synced: all.filter((skill) => skill.source === 'synced').length,
		};
		const chips: Array<[SkillFilter, string]> = [
			['local', 'All'],
			['user', 'Local'],
			['plugin', 'Plugins'],
			['project', 'Project'],
			['synced', 'Synced'],
			['off', 'Off'],
			['issues', 'Issues'],
		];
		// The Off and Issues chips are drawn only while they have something to
		// show; a pane left on one that empties shows All.
		const isEmptyChip = (value: SkillFilter) =>
			(value === 'issues' || value === 'off') && counts[value] === 0;
		const chosen: SkillFilter = isEmptyChip(picked) ? 'local' : picked;
		const keeps = (skill: SkillEntry): boolean => {
			if (chosen === 'local') return true;
			if (chosen === 'off') return isLocal(skill) && skill.isOff;
			if (chosen === 'issues') return hasIssue(skill);

			return skill.source === chosen;
		};
		const shown = all.filter(keeps);
		const isAll = chosen === 'local';
		const isAcross = chosen === 'off' || chosen === 'issues';
		const user = shown.filter((skill) => skill.source === 'user');
		const project = shown.filter((skill) => skill.source === 'project');
		const plugins = shown.filter((skill) => skill.source === 'plugin');
		const synced = shown.filter((skill) => skill.source === 'synced');
		const listedPlugins =
			isAll || chosen === 'plugin'
				? data.plugins
				: data.plugins.filter((plugin) =>
						plugins.some((skill) => skill.group === plugin.name),
					);
		const time = new Date(data.scannedAt).toLocaleTimeString([], {
			hour: 'numeric',
			minute: '2-digit',
		});
		const syncedOn = data.syncedAt
			? new Date(data.syncedAt).toLocaleDateString([], {
					month: 'short',
					day: 'numeric',
				})
			: undefined;
		const showUser = isAll || user.length > 0 || chosen === 'user';
		const showProject = isAll || project.length > 0 || chosen === 'project';
		const showPlugins =
			listedPlugins.length > 0 || isAll || chosen === 'plugin';
		const showSynced = isAll || synced.length > 0 || chosen === 'synced';
		// Leftover settings are an issue to fix, so they show under Issues only.
		const shownStale = chosen === 'issues' ? stale : [];
		const openUser = showUser && !isClosed('local');
		const openPlugins = showPlugins && !isClosed('plugins');
		const openProject = showProject && !isClosed('project');
		const openSynced = showSynced && !isClosed('synced');
		const tokenText =
			tokenTotal >= 1000
				? `${(tokenTotal / 1000).toFixed(1)}k`
				: `${tokenTotal}`;

		return (
			<Box flexDirection="column">
				<Box
					flexDirection="row"
					justifyContent="space-between"
					alignItems="center"
				>
					<Text dimColor size="footnote">
						{all.length} skills · {counts.off} off · ≈ {tokenText}{' '}
						tokens each session · read {time}
					</Text>
					<Box flexDirection="row" gap={1}>
						<Button
							label="Refresh"
							dimColor
							onPress={() => void rescan($)}
						/>
					</Box>
				</Box>

				{shownNotice && (
					<Box marginTop="xs">
						<Text
							color={shownNotice.isError ? 'warning' : 'success'}
							size="footnote"
						>
							{`${shownNotice.isError ? '⚠' : '✓'} ${shownNotice.text}`}
						</Text>
					</Box>
				)}

				<Box flexDirection="row" flexWrap="wrap" gap={1} marginTop={1}>
					{chips
						.filter(([value]) => !isEmptyChip(value))
						.map(([value, label]) => (
							<Button
								key={`chip:${value}`}
								variant={
									chosen === value ? 'primary' : 'secondary'
								}
								onPress={() =>
									void update($, filter, () => value)
								}
							>
								{`${label} ${counts[value]}`}
							</Button>
						))}
				</Box>

				{!isAll && shown.length + shownStale.length === 0 && (
					<Box marginTop={1}>
						{note('Nothing matches this filter.')}
					</Box>
				)}

				{showUser &&
					heading(
						'Local',
						data.userDir,
						SOURCE_COLOR.user,
						user.length,
						countOff(user),
						'local',
					)}
				{openUser &&
					user.length === 0 &&
					note('No skills in this folder.')}
				{openUser && user.map(row)}

				{showPlugins &&
					heading(
						'Plugins',
						'enabled',
						SOURCE_COLOR.plugin,
						`${listedPlugins.length} · ${plugins.length} skills`,
						countOff(plugins),
						'plugins',
					)}
				{openPlugins &&
					listedPlugins.length === 0 &&
					note('No enabled plugins.')}
				{openPlugins &&
					listedPlugins.map((plugin) => {
						const own = plugins.filter(
							(skill) => skill.group === plugin.name,
						);
						const commands = isAcross
							? []
							: data.commands.filter(
									(command) => command.group === plugin.name,
								);
						if (own.length + commands.length === 0)
							return bare(plugin);
						const tally = [
							own.length ? plural(own.length, 'skill') : '',
							commands.length
								? plural(commands.length, 'command')
								: '',
						]
							.filter(Boolean)
							.join(' · ');

						return fold(
							`group:${plugin.name}`,
							plugin.name,
							[...own, ...commands],
							isAcross,
							pluginTags(plugin),
							tally,
						);
					})}

				{showProject &&
					heading(
						'Project',
						'.claude/skills',
						SOURCE_COLOR.project,
						project.length,
						countOff(project),
						'project',
					)}
				{openProject &&
					project.length === 0 &&
					note('None in this project.')}
				{openProject && project.map(row)}

				{showSynced &&
					heading(
						'claude.ai account',
						syncedOn
							? `enabled only · synced ${syncedOn}`
							: 'enabled only',
						SOURCE_COLOR.synced,
						synced.length,
						countOff(synced),
						'synced',
					)}
				{openSynced &&
					synced.length === 0 &&
					note('No synced account skills.')}
				{openSynced && !isAll && synced.map(row)}
				{openSynced &&
					isAll &&
					synced.length > 0 &&
					fold(
						'group:synced',
						'Show synced account skills',
						synced,
						false,
					)}

				{shownStale.length > 0 &&
					heading(
						'Leftover settings',
						'turned off, but the skill is gone',
						'warning',
						plural(shownStale.length, 'stale entry').replace(
							'entrys',
							'entries',
						),
						0,
						'leftover',
					)}
				{!isClosed('leftover') &&
					shownStale.map((entry) => (
						<Box
							key={`stale:${entry.key}`}
							flexDirection="column"
							paddingLeft={2}
							marginTop="xs"
						>
							<Box
								flexDirection="row"
								alignItems="center"
								gap={1}
							>
								<Text color="warning">●</Text>
								<Text>{entry.key}</Text>
								<Text color="warning" size="caption">
									⚠ Still set to "{entry.value}" in
									skillOverrides, but no skill has this name
								</Text>
							</Box>
							<Box
								paddingLeft={4}
								flexDirection="row"
								marginTop="xs"
							>
								<Button
									key={`remove-override:${entry.key}`}
									label="Remove from settings"
									onPress={() =>
										void removeStale($, entry.key)
									}
								/>
							</Box>
						</Box>
					))}
			</Box>
		);
	});
};
