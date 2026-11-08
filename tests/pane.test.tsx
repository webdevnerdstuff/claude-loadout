import type { On } from 'claude-code';
import type { TestBody } from 'claude-code/testing';
import { expect, test } from 'claude-code/testing';

import { ringStep } from '../hooks/register';

const PANE = {
	plugin: 'loadout',
	component: 'Pane',
	requestId: 'loadout',
	props: {
		title: 'Loadout',
		isFocused: false,
		bodyColumns: 80,
		placement: 'dock',
		scroll: { offset: 0, bodyRows: 60 },
		view: {},
	},
} as const;

const HOME = '/home/test';
const SYNCED = `${HOME}/Library/Application Support/Claude/local-agent-mode-sessions/skills-plugin/org/account`;

type Node = {
	kind: 'dir' | 'file';
	text?: string;
	linkTo?: string;
	isBroken?: boolean;
};

const skill = (name: string, description: string): string =>
	`---\nname: ${name}\ndescription: >\n  ${description}\n---\n\nBody.\n`;

// A small machine: two local skills, a symlinked one, a broken link, a folder
// with no SKILL.md, two enabled plugins (one with no skills), one disabled
// plugin, a plugin from CLAUDE_CODE_PLUGIN_DIRS, and the account's synced list.
const FILES: Record<string, Node> = {
	[`${HOME}/.claude/skills`]: { kind: 'dir' },
	[`${HOME}/.claude/skills/gac`]: { kind: 'dir' },
	[`${HOME}/.claude/skills/gac/SKILL.md`]: {
		kind: 'file',
		text: skill('gac', 'Git add and commit helper.'),
	},
	[`${HOME}/.claude/skills/cr`]: { kind: 'dir' },
	[`${HOME}/.claude/skills/cr/SKILL.md`]: {
		kind: 'file',
		text: skill('cr', 'Project-aware code review.'),
	},
	[`${HOME}/.claude/skills/linked`]: {
		kind: 'dir',
		linkTo: `${HOME}/.agents/skills/linked`,
	},
	[`${HOME}/.claude/skills/linked/SKILL.md`]: {
		kind: 'file',
		text: skill('linked', 'A skill kept elsewhere.'),
	},
	[`${HOME}/.claude/skills/broken`]: {
		kind: 'dir',
		linkTo: `${HOME}/gone`,
		isBroken: true,
	},
	[`${HOME}/.claude/skills/empty`]: { kind: 'dir' },
	[`${HOME}/.claude/skills/synced`]: { kind: 'dir' },
	[`${HOME}/.claude/plugins/installed_plugins.json`]: {
		kind: 'file',
		text: JSON.stringify({
			plugins: {
				'tools@market': [
					{
						scope: 'user',
						installPath: '/plugins/tools',
						version: '1.2.0',
					},
				],
				'hooks-only@market': [
					{ scope: 'user', installPath: '/plugins/hooks-only' },
				],
				'disabled@market': [
					{ scope: 'user', installPath: '/plugins/disabled' },
				],
			},
		}),
	},
	'/plugins/tools/.claude-plugin/plugin.json': {
		kind: 'file',
		text: '{"name":"tools","version":"1.2.0","author":{"name":"Tool Maker"}}',
	},
	'/plugins/tools/skills': { kind: 'dir' },
	'/plugins/tools/skills/plan': { kind: 'dir' },
	'/plugins/tools/skills/plan/SKILL.md': {
		kind: 'file',
		text: skill('plan', 'Write a plan first.'),
	},
	'/plugins/hooks-only/.claude-plugin/plugin.json': {
		kind: 'file',
		text: '{"name":"hooks-only"}',
	},
	'/plugins/disabled/.claude-plugin/plugin.json': {
		kind: 'file',
		text: '{"name":"disabled"}',
	},
	'/plugins/disabled/skills': { kind: 'dir' },
	'/plugins/disabled/skills/hidden': { kind: 'dir' },
	'/plugins/disabled/skills/hidden/SKILL.md': {
		kind: 'file',
		text: skill('hidden', 'Never listed.'),
	},
	'/dev/mover/hooks/hooks.json': {
		kind: 'file',
		text: '{"modules":["./register.tsx"]}',
	},
	'/dev/mover/hooks/register.tsx': { kind: 'file', text: '' },
	'/dev/mover/.claude-plugin/plugin.json': {
		kind: 'file',
		text: '{"name":"mover","version":"0.1.0"}',
	},
	[`${HOME}/Library/Application Support/Claude/local-agent-mode-sessions/skills-plugin`]:
		{ kind: 'dir' },
	[`${HOME}/Library/Application Support/Claude/local-agent-mode-sessions/skills-plugin/org`]:
		{ kind: 'dir' },
	[SYNCED]: { kind: 'dir' },
	[`${SYNCED}/manifest.json`]: {
		kind: 'file',
		text: JSON.stringify({
			lastUpdated: 1794090077312,
			skills: [
				{
					name: 'pdf',
					description: 'Work with PDFs.',
					enabled: true,
					source: 'anthropic',
				},
				{
					name: 'cr',
					description: 'An account copy of cr.',
					enabled: true,
					creatorType: 'user',
					backingPluginId: 'plugin_1',
				},
				{
					name: 'old',
					description: 'Turned off on the account.',
					enabled: false,
				},
			],
		}),
	},
	[`${SYNCED}/skills/pdf/SKILL.md`]: {
		kind: 'file',
		text: skill('pdf', 'Work with PDFs.'),
	},
};

const SETTINGS = {
	skillOverrides: { cr: 'off' },
	enabledPlugins: {
		'tools@market': true,
		'hooks-only@market': true,
		'disabled@market': false,
	},
};

const fail = (path: string): never => {
	throw new Error(`ENOENT: ${path}`);
};

const childrenOf = (files: Record<string, Node>, path: string) =>
	Object.entries(files)
		.filter(
			([key]) =>
				key.startsWith(`${path}/`) &&
				!key.slice(path.length + 1).includes('/'),
		)
		.map(([key, node]) => ({
			name: key.slice(path.length + 1),
			kind: node.linkTo ? ('other' as const) : node.kind,
			size: 0,
			mtimeMs: 0,
			isLink: Boolean(node.linkTo),
		}));

// What GitHub answers in a test: raw file text by URL; anything else is a 404.
let WEB: Record<string, string> = {};

type Engine = {
	draft: string;
	fills: string[];
	stored: Record<string, unknown>;
	runs: string[][];
	writes: Record<string, string>;
	opens: Record<string, unknown>[];
	// What ui.open answers: placed, unless a test says why not.
	notPlaced?: string;
};

// Every hook here stands for the engine beneath the plugin: the file system,
// settings, environment, store and prompt box of the machine above.
function engine(
	on: On,
	files: Record<string, Node> = FILES,
	settings: Record<string, unknown> = SETTINGS,
): Engine {
	const state: Engine = {
		draft: 'fix the header',
		fills: [],
		stored: {},
		runs: [],
		writes: {},
		opens: [],
	};
	on('command.register', () => ({ value: { command: 'loadout' } }));
	on('ui.open', (_, e) => {
		state.opens.push({ ...e });

		return {
			value: state.notPlaced
				? { isPlaced: false, reason: state.notPlaced }
				: { isPlaced: true },
		};
	});
	on('ui.toast', () => ({ value: undefined }));
	on('session.start', (_, e) => ({ cwd: e.cwd }));
	on('session.root', () => ({ value: '/project' }));
	on('env.get', (_, e) => ({
		value: e.name === 'HOME' ? HOME : '/dev/mover',
	}));
	on('settings.read', () => ({ value: settings }));
	on('store.get', (_, e) => ({ value: state.stored[e.key] }));
	on('store.set', (_, e) => {
		state.stored[e.key] = e.value;

		return { value: undefined };
	});
	on('fs.list', (_, e) =>
		files[e.path]?.kind === 'dir'
			? { value: childrenOf(files, e.path) }
			: fail(e.path),
	);
	on('fs.read', (_, e) => {
		const text = files[e.path]?.text;

		return typeof text === 'string' ? { value: text } : fail(e.path);
	});
	on('fs.stat', (_, e) => {
		const node = files[e.path];
		if (!node || node.isBroken) return fail(e.path);

		return {
			value: {
				kind: node.kind,
				size: 0,
				mtimeMs: 0,
				isLink: Boolean(node.linkTo),
				realPath: node.linkTo ?? e.path,
			},
		};
	});
	on('prompt.read', () => ({ value: { text: state.draft, cursor: 0 } }));
	on('prompt.fill', (_, e) => {
		state.fills.push(e.text);

		return { isFilled: true, text: e.text, cursor: e.text.length };
	});
	on('skill.prompt', (_, e) => ({ text: e.text }));
	on('process.run', (_, e) => {
		state.runs.push([...e.argv]);

		return {
			value: {
				exitCode: 0,
				stdout: e.argv[0] === 'uname' ? 'Darwin\n' : '',
				stderr: '',
				isStdoutTruncated: false,
				isStderrTruncated: false,
			},
		};
	});
	on('fs.exists', (_, e) => ({ value: Boolean(files[e.path]) }));
	on('http.fetch', (_, e) => {
		const text = WEB[e.url];

		return {
			value: {
				ok: text !== undefined,
				status: text !== undefined ? 200 : 404,
				headers: {},
				text: text ?? '',
			},
		};
	});
	on('fs.write', (_, e) => {
		state.writes[e.path] = e.text;

		return { value: undefined };
	});
	// What the engine lists: a mod's command registered in code, a plugin's
	// command, and its skill listed as a command too (left out of the pane).
	on('command.list', () => ({
		value: [
			{
				name: 'move-me',
				description: 'Move things.',
				source: 'plugin',
				plugin: 'mover',
			},
			{
				name: 'tools:lint',
				description: 'Lint the code.',
				source: 'plugin',
				plugin: 'tools',
			},
			{
				name: 'tools:plan',
				description: 'Write a plan first.',
				source: 'plugin',
				plugin: 'tools',
			},
			{ name: 'help', description: 'Show help.', source: 'builtin' },
			{
				name: 'init',
				description: 'Set up CLAUDE.md.',
				source: 'builtin',
			},
		],
	}));

	return state;
}

const mount = async (
	$: Parameters<TestBody>[0],
	surface: 'desktop' | 'terminal' = 'desktop',
) => {
	await $.session.start({ cwd: '/project', surface, isInteractive: true });
	const ui = await $.ui.mount({ ...PANE, surface });
	await ui.press({ key: 'Refresh' });

	return ui;
};

test('All lists every source, flags problems and leaves disabled things out', async ($, on) => {
	engine(on);
	const ui = await mount($);

	expect(
		(await ui.find({ type: 'Button', key: 'row:user:user:gac' }))?.text,
	).toBe('▸ gac');
	expect((await ui.find({ type: 'Text', text: 'OFF' }))?.text).toBe('OFF');
	expect(
		(await ui.find({ type: 'Text', text: /Broken symlink/ }))?.text,
	).toBe('⚠ Broken symlink');
	expect((await ui.find({ type: 'Text', text: /No SKILL\.md/ }))?.text).toBe(
		'⚠ No SKILL.md',
	);
	expect(
		await ui.find({ type: 'Text', text: '↪ ~/.agents' }),
	).toBeUndefined();
	expect(
		(await ui.find({ type: 'Button', key: 'fold:group:tools' }))?.text,
	).toBe('▸ tools (1 skill · 1 command)');
	expect((await ui.find({ type: 'Text', text: /hooks-only/ }))?.text).toBe(
		'  hooks-only',
	);
	expect(
		(await ui.find({ type: 'Text', text: /no skills or commands/ }))?.text,
	).toBe('no skills or commands');
	expect(
		(await ui.find({ type: 'Button', key: 'fold:group:mover' }))?.text,
	).toBe('▸ mover (1 command)');
	expect(
		await ui.find({ type: 'Text', text: /local folder/ }),
	).toBeUndefined();
	await ui.press({ key: 'fold:group:mover' });
	expect((await ui.find({ type: 'Text', text: /local folder/ }))?.text).toBe(
		'v0.1.0 · local folder · no context cost',
	);
	expect(await ui.find({ type: 'Text', text: /disabled/ })).toBeUndefined();
	expect(
		(await ui.find({ type: 'Button', key: 'fold:group:synced-yours' }))
			?.text,
	).toBe('▸ Yours (1)');
	expect(
		(await ui.find({ type: 'Button', key: 'fold:group:synced-documents' }))
			?.text,
	).toBe('▸ Anthropic document skills (1)');
	await ui.unmount();
});

test('the Off chip narrows to the skills turned off', async ($, on) => {
	engine(on);
	const ui = await mount($);
	await ui.press({ key: 'chip:off' });

	expect(
		(await ui.find({ type: 'Button', key: 'row:user:user:cr' }))?.text,
	).toBe('▸ cr');
	expect(
		await ui.find({ type: 'Button', key: 'row:user:user:gac' }),
	).toBeUndefined();
	await ui.unmount();
});

test('Synced lists only enabled account skills and flags a name found locally too', async ($, on) => {
	engine(on);
	const ui = await mount($);
	await ui.press({ key: 'chip:synced' });

	expect(
		(await ui.find({ type: 'Button', key: 'row:synced:account:pdf' }))
			?.text,
	).toBe('▸ pdf');
	expect(await ui.find({ type: 'Button', text: /old/ })).toBeUndefined();
	expect((await ui.find({ type: 'Text', text: /Also in Local/ }))?.text).toBe(
		'⚠ Also in Local',
	);
	await ui.unmount();
});

test('Insert puts the command in front of the draft without sending it', async ($, on) => {
	const state = engine(on);
	const ui = await mount($);
	await ui.press({ key: 'row:user:user:gac' });
	await ui.press({ key: 'insert:user:user:gac' });

	expect(state.fills).toEqual(['/gac fix the header']);
	await ui.unmount();
});

test('a skill run is counted and shown on its row', async ($, on) => {
	const state = engine(on);
	const ui = await mount($, 'terminal');
	await $.skill.prompt({
		skill: 'gac',
		text: 'Body.',
		frontmatter: {},
		source: 'userSettings',
	});

	expect(
		(state.stored.usage as Record<string, { count: number }>).gac?.count,
	).toBe(1);
	expect((await ui.find({ type: 'Text', text: /1×/ }))?.text).toMatch(
		/^1× · /,
	);
	await ui.unmount();
});

test('a plugin with only commands opens to them, and Insert uses the command', async ($, on) => {
	const state = engine(on);
	const ui = await mount($);
	await ui.press({ key: 'fold:group:mover' });
	await ui.press({ key: 'row:command:mover:move-me' });

	expect(
		(await ui.find({ type: 'Button', key: 'row:command:mover:move-me' }))
			?.text,
	).toBe('▾ /move-me');
	expect((await ui.find({ type: 'Text', text: /Move things/ }))?.text).toBe(
		'Move things.',
	);
	await ui.press({ key: 'insert:command:mover:move-me' });
	expect(state.fills).toEqual(['/move-me fix the header']);

	await ui.press({ key: 'fold:group:tools' });
	expect(
		await ui.find({ type: 'Button', key: 'row:command:tools:tools:plan' }),
	).toBeUndefined();
	await ui.unmount();
});

test('the Issues chip shows only while something is flagged', async ($, on) => {
	engine(on);
	const flagged = await mount($);
	expect(
		(await flagged.find({ type: 'Button', key: 'chip:issues' }))?.text,
	).toMatch(/^Issues \d+$/);
	await flagged.unmount();
});

test('with nothing flagged there is no Issues chip', async ($, on) => {
	const clean = Object.fromEntries(
		Object.entries(FILES).filter(
			([path]) =>
				!/\/skills\/(broken|empty)(\/|$)/.test(path) &&
				!path.endsWith('manifest.json'),
		),
	);
	engine(on, clean);
	const ui = await mount($);
	expect(
		await ui.find({ type: 'Button', key: 'chip:issues' }),
	).toBeUndefined();
	expect(
		(await ui.find({ type: 'Button', key: 'chip:local' }))?.text,
	).toMatch(/^All /);
	await ui.unmount();
});

test('a flagged skill offers fixes instead of Insert', async ($, on) => {
	engine(on);
	const ui = await mount($);
	await ui.press({ key: 'row:user:user:broken' });

	expect(
		await ui.find({ type: 'Button', key: 'insert:user:user:broken' }),
	).toBeUndefined();
	expect(
		(await ui.find({ type: 'Button', key: 'remove:user:user:broken' }))
			?.text,
	).toBe('Remove link');
	expect(
		(await ui.find({ type: 'Button', key: 'reveal:user:user:broken' }))
			?.text,
	).toBe('Finder ↗');
	await ui.unmount();
});

test('Remove link asks once more, then removes only the link', async ($, on) => {
	const state = engine(on);
	const ui = await mount($);
	await ui.press({ key: 'row:user:user:broken' });
	await ui.press({ key: 'remove:user:user:broken' });
	expect(state.runs.some((argv) => argv[0] === 'rm')).toBe(false);

	await ui.press({ key: 'confirm-remove:user:user:broken' });
	expect(state.runs).toContainEqual(['rm', `${HOME}/.claude/skills/broken`]);
	await ui.unmount();
});

test('Create SKILL.md writes a starter file named after the folder', async ($, on) => {
	const state = engine(on);
	const ui = await mount($);
	await ui.press({ key: 'row:user:user:empty' });
	await ui.press({ key: 'create:user:user:empty' });

	const file = `${HOME}/.claude/skills/empty/SKILL.md`;
	expect(state.writes[file]).toMatch(/^---\nname: empty\ndescription: /);
	expect(state.runs).toContainEqual([
		'open',
		'-a',
		'Visual Studio Code',
		file,
	]);
	await ui.unmount();
});

test('Ask Claude puts a question about a duplicate in the prompt box', async ($, on) => {
	const state = engine(on);
	const ui = await mount($);
	await ui.press({ key: 'chip:synced' });
	await ui.press({ key: 'row:synced:account:cr' });
	await ui.press({ key: 'ask:synced:account:cr' });

	expect(state.fills[0]).toMatch(
		/^fix the header\n\nThe skill "cr" .* is also in Local\./,
	);
	await ui.unmount();
});

const skillAt = (folder: string, text: string): Record<string, Node> => ({
	[`${HOME}/.claude/skills/${folder}`]: { kind: 'dir' },
	[`${HOME}/.claude/skills/${folder}/SKILL.md`]: { kind: 'file', text },
});

test('the new checks flag what a SKILL.md gets wrong', async ($, on) => {
	const long = 'Use this when testing. '.repeat(50);
	engine(
		on,
		{
			...FILES,
			...skillAt('no-header', 'Just instructions, no frontmatter.\n'),
			...skillAt(
				'refs',
				`${skill('refs', 'Follows the guide in the reference folder.')}See [the guide](references/guide.md).\n`,
			),
			...skillAt('wordy', skill('wordy', long)),
			...skillAt(
				'Bad_Name',
				skill('Bad_Name', 'A skill whose name breaks the naming rule.'),
			),
			...skillAt(
				'folder-a',
				skill(
					'other-name',
					'A skill whose name is not its folder name.',
				),
			),
			...skillAt(
				'init',
				skill('init', 'A skill that a built-in command shadows.'),
			),
			[`${HOME}/.claude/skills/lower`]: { kind: 'dir' },
			[`${HOME}/.claude/skills/lower/skill.md`]: {
				kind: 'file',
				text: skill(
					'lower',
					'A skill whose file name is in lowercase letters.',
				),
			},
		},
		{ ...SETTINGS, skillOverrides: { cr: 'off', ghost: 'off' } },
	);
	const ui = await mount($);
	await ui.press({ key: 'chip:issues' });

	const flag = async (text: RegExp) =>
		(await ui.find({ type: 'Text', text }))?.text;
	expect(await flag(/No frontmatter/)).toBe('⚠ No frontmatter');
	expect(await flag(/Missing file/)).toBe(
		'⚠ Missing file references/guide.md',
	);
	expect(await flag(/limit 1,024/)).toMatch(
		/^⚠ Description is [\d,]+ characters \(limit 1,024\)$/,
	);
	expect(await flag(/naming rule|lowercase letters, digits/)).toBe(
		'⚠ Name "Bad_Name" should be lowercase letters, digits and hyphens',
	);
	expect(await flag(/differs from its folder/)).toBe(
		'⚠ Name "other-name" differs from its folder "folder-a"',
	);
	expect(await flag(/built-in command/)).toBe(
		'⚠ /init is also a built-in command',
	);
	expect(await flag(/looks for SKILL\.md/)).toBe(
		'⚠ Named skill.md; Claude Code looks for SKILL.md',
	);
	expect(await flag(/skill has this name/)).toMatch(
		/^⚠ Still set to "off" in skillOverrides, but no\s+skill has this name$/,
	);
	expect(
		(await ui.find({ type: 'Button', key: 'remove-override:ghost' }))?.text,
	).toBe('Remove from settings');
	await ui.unmount();
});

test('Add frontmatter puts a header above the existing text', async ($, on) => {
	const state = engine(on, {
		...FILES,
		...skillAt('no-header', 'Just instructions, no frontmatter.\n'),
	});
	const ui = await mount($);
	await ui.press({ key: 'row:user:user:no-header' });
	await ui.press({ key: 'frontmatter:user:user:no-header' });

	expect(state.writes[`${HOME}/.claude/skills/no-header/SKILL.md`]).toMatch(
		/^---\nname: no-header\ndescription: .*\n---\n\nJust instructions, no frontmatter\.\n$/,
	);
	await ui.unmount();
});

test('a short description is a hint, not an issue', async ($, on) => {
	engine(on);
	const ui = await mount($);
	expect(
		(await ui.find({ type: 'Text', text: /Short description/ }))?.text,
	).toMatch(/^ⓘ /);
	await ui.unmount();
});

test('with nothing turned off there is no Off chip', async ($, on) => {
	engine(on, FILES, { ...SETTINGS, skillOverrides: {} });
	const ui = await mount($);
	expect(await ui.find({ type: 'Button', key: 'chip:off' })).toBeUndefined();
	expect(await ui.find({ type: 'Text', text: 'OFF' })).toBeUndefined();
	await ui.unmount();
});

test('Delete on a skill that is off moves its folder to the Trash after a second click', async ($, on) => {
	const state = engine(on);
	const ui = await mount($);
	await ui.press({ key: 'row:user:user:cr' });
	expect(
		await ui.find({ type: 'Button', key: 'insert:user:user:cr' }),
	).toBeUndefined();
	await ui.press({ key: 'delete:user:user:cr' });
	expect(state.runs.some((argv) => argv[0] === 'mv')).toBe(false);

	await ui.press({ key: 'confirm-delete:user:user:cr' });
	expect(state.runs).toContainEqual([
		'mv',
		'-n',
		`${HOME}/.claude/skills/cr`,
		`${HOME}/.Trash/cr`,
	]);
	await ui.unmount();
});

test('Delete on a symlinked skill removes only the link', async ($, on) => {
	const state = engine(on, FILES, {
		...SETTINGS,
		skillOverrides: { linked: 'off' },
	});
	const ui = await mount($);
	await ui.press({ key: 'row:user:user:linked' });
	expect(
		(await ui.find({ type: 'Button', key: 'delete:user:user:linked' }))
			?.text,
	).toBe('Delete shortcut');
	await ui.press({ key: 'delete:user:user:linked' });
	await ui.press({ key: 'confirm-delete:user:user:linked' });

	expect(state.runs).toContainEqual(['rm', `${HOME}/.claude/skills/linked`]);
	expect(state.runs.some((argv) => argv[0] === 'mv')).toBe(false);
	await ui.unmount();
});

test('every local skill has Remove, a plugin skill has none', async ($, on) => {
	engine(on);
	const ui = await mount($);
	await ui.press({ key: 'row:user:user:gac' });
	expect(
		(await ui.find({ type: 'Button', key: 'delete:user:user:gac' }))?.text,
	).toBe('Trash');
	await ui.press({ key: 'delete:user:user:gac' });
	expect(
		(await ui.find({ type: 'Button', key: 'confirm-delete:user:user:gac' }))
			?.text,
	).toBe('Confirm: move to Trash');

	await ui.press({ key: 'fold:group:tools' });
	await ui.press({ key: 'row:plugin:tools:plan' });
	expect(
		await ui.find({ type: 'Button', key: 'delete:plugin:tools:plan' }),
	).toBeUndefined();
	await ui.unmount();
});

const USER_SETTINGS = `${HOME}/.claude/settings.json`;
const SETTINGS_TEXT = `{
  "env": {
    "SECRET_TOKEN": "keep-me"
  },
  "skillOverrides": {
    "cr": "off",
    "ghost": "off"
  },
  "theme": "dark"
}
`;

const withSettings = (text: string): Record<string, Node> => ({
	...FILES,
	[USER_SETTINGS]: { kind: 'file', text },
});

test('Turn on removes only that skill\'s "off" entry and keeps the rest of the file', async ($, on) => {
	const state = engine(on, withSettings(SETTINGS_TEXT), {
		...SETTINGS,
		skillOverrides: { cr: 'off', ghost: 'off' },
	});
	const ui = await mount($);
	await ui.press({ key: 'row:user:user:cr' });
	await ui.press({ key: 'turn-on:user:user:cr' });

	expect(state.writes[USER_SETTINGS]).toBe(
		SETTINGS_TEXT.replace('    "cr": "off",\n', ''),
	);
	expect(state.fills).toEqual([]);
	await ui.unmount();
});

test('Delete also removes the skill\'s "off" entry', async ($, on) => {
	const state = engine(on, withSettings(SETTINGS_TEXT));
	const ui = await mount($);
	await ui.press({ key: 'row:user:user:cr' });
	await ui.press({ key: 'delete:user:user:cr' });
	await ui.press({ key: 'confirm-delete:user:user:cr' });

	expect(
		JSON.parse(state.writes[USER_SETTINGS] ?? '{}').skillOverrides,
	).toEqual({
		ghost: 'off',
	});
	await ui.unmount();
});

test('Remove from settings drops a leftover entry', async ($, on) => {
	const state = engine(on, withSettings(SETTINGS_TEXT), {
		...SETTINGS,
		skillOverrides: { cr: 'off', ghost: 'off' },
	});
	const ui = await mount($);
	expect(
		await ui.find({ type: 'Button', key: 'remove-override:ghost' }),
	).toBeUndefined();
	await ui.press({ key: 'chip:issues' });
	await ui.press({ key: 'remove-override:ghost' });

	const written = JSON.parse(state.writes[USER_SETTINGS] ?? '{}');
	expect(written.skillOverrides).toEqual({ cr: 'off' });
	expect(written.env).toEqual({ SECRET_TOKEN: 'keep-me' });
	await ui.unmount();
});

test('a settings file that does not parse is never written', async ($, on) => {
	const state = engine(
		on,
		withSettings('{ "skillOverrides": { "cr": "off", '),
	);
	const ui = await mount($);
	await ui.press({ key: 'row:user:user:cr' });
	await ui.press({ key: 'turn-on:user:user:cr' });

	expect(state.writes[USER_SETTINGS]).toBeUndefined();
	await ui.unmount();
});

test('a skill turned on shows as on before Claude Code reloads its settings', async ($, on) => {
	// The loaded settings stay stale: they still say "off" after the write.
	engine(on, withSettings(SETTINGS_TEXT), {
		...SETTINGS,
		skillOverrides: { cr: 'off', ghost: 'off' },
	});
	const ui = await mount($);
	await ui.press({ key: 'row:user:user:cr' });
	await ui.press({ key: 'turn-on:user:user:cr' });

	expect(
		await ui.find({ type: 'Button', key: 'turn-on:user:user:cr' }),
	).toBeUndefined();
	expect(await ui.find({ type: 'Text', text: 'OFF' })).toBeUndefined();
	await ui.press({ key: 'Refresh' });
	expect(
		await ui.find({ type: 'Button', key: 'turn-on:user:user:cr' }),
	).toBeUndefined();
	await ui.unmount();
});

test('a local skill that a disabled plugin also ships is flagged', async ($, on) => {
	engine(on, {
		...FILES,
		...skillAt(
			'hidden',
			skill('hidden', "A local copy of the disabled plugin's skill."),
		),
	});
	const ui = await mount($);
	expect(
		(await ui.find({ type: 'Text', text: /disabled plugin \(off\)/ }))
			?.text,
	).toBe('⚠ Also in disabled plugin (off)');
	expect(
		await ui.find({ type: 'Button', key: 'fold:group:disabled' }),
	).toBeUndefined();
	await ui.unmount();
});

const LOCK = {
	[`${HOME}/.agents/.skill-lock.json`]: {
		kind: 'file' as const,
		text: JSON.stringify({
			skills: {
				linked: {
					source: 'someone/skills',
					installedAt: '2026-10-29T19:48:44.980Z',
				},
			},
		}),
	},
};

test('a skill npx skills installed says so, with its source', async ($, on) => {
	engine(on, { ...FILES, ...LOCK });
	const ui = await mount($);
	await ui.press({ key: 'row:user:user:linked' });
	expect((await ui.find({ type: 'Text', text: /npx skills/ }))?.text).toMatch(
		/^npx skills · someone\/skills · Oct 29, 2026$/,
	);
	await ui.unmount();
});

test('Uninstall on an npx skills install needs no Node: Trash, shortcut and lock entry', async ($, on) => {
	const state = engine(
		on,
		{
			...FILES,
			...LOCK,
			[`${HOME}/.agents/skills`]: { kind: 'dir' },
			[`${HOME}/.agents/skills/linked`]: { kind: 'dir' },
		},
		{ ...SETTINGS, skillOverrides: { linked: 'off' } },
	);
	const ui = await mount($);
	await ui.press({ key: 'row:user:user:linked' });
	expect(
		(await ui.find({ type: 'Button', key: 'delete:user:user:linked' }))
			?.text,
	).toBe('Uninstall');
	await ui.press({ key: 'delete:user:user:linked' });
	await ui.press({ key: 'confirm-delete:user:user:linked' });

	expect(state.runs).toContainEqual([
		'mv',
		'-n',
		`${HOME}/.agents/skills/linked`,
		`${HOME}/.Trash/linked`,
	]);
	expect(state.runs).toContainEqual(['rm', `${HOME}/.claude/skills/linked`]);
	expect(state.runs.some((argv) => argv[0] === 'npx')).toBe(false);
	expect(
		JSON.parse(state.writes[`${HOME}/.agents/.skill-lock.json`] ?? '{}')
			.skills,
	).toEqual({});
	await ui.unmount();
});

test('a duplicate of a disabled plugin offers to uninstall that plugin', async ($, on) => {
	const state = engine(on, {
		...FILES,
		...skillAt(
			'hidden',
			skill('hidden', "A local copy of the disabled plugin's skill."),
		),
	});
	const ui = await mount($);
	await ui.press({ key: 'row:user:user:hidden' });
	await ui.press({ key: 'uninstall:user:user:hidden' });
	expect(state.runs.some((argv) => argv[0] === 'claude')).toBe(false);
	expect(
		(
			await ui.find({
				type: 'Button',
				key: 'confirm-uninstall:user:user:hidden',
			})
		)?.text,
	).toBe('Confirm: uninstall disabled');
	await ui.press({ key: 'confirm-uninstall:user:user:hidden' });

	expect(state.runs).toContainEqual([
		'claude',
		'plugin',
		'uninstall',
		'disabled@market',
	]);
	expect(state.runs.some((argv) => argv.includes('marketplace'))).toBe(false);
	await ui.unmount();
});

test('the last plugin from a marketplace takes the marketplace with it', async ($, on) => {
	const state = engine(on, {
		...FILES,
		[`${HOME}/.claude/plugins/installed_plugins.json`]: {
			kind: 'file',
			text: JSON.stringify({
				plugins: {
					'disabled@solo': [
						{ scope: 'user', installPath: '/plugins/disabled' },
					],
				},
			}),
		},
		...skillAt(
			'hidden',
			skill('hidden', "A local copy of the disabled plugin's skill."),
		),
	});
	const ui = await mount($);
	await ui.press({ key: 'row:user:user:hidden' });
	await ui.press({ key: 'uninstall:user:user:hidden' });
	await ui.press({ key: 'confirm-uninstall:user:user:hidden' });

	expect(state.runs).toContainEqual([
		'claude',
		'plugin',
		'uninstall',
		'disabled@solo',
	]);
	expect(state.runs).toContainEqual([
		'claude',
		'plugin',
		'marketplace',
		'remove',
		'solo',
	]);
	await ui.unmount();
});

test('a section heading closes and opens its section', async ($, on) => {
	engine(on);
	const ui = await mount($);
	expect(
		(await ui.find({ type: 'Button', key: 'section:local' }))?.text,
	).toBe('▾ LOCAL');
	await ui.press({ key: 'section:local' });

	expect(
		(await ui.find({ type: 'Button', key: 'section:local' }))?.text,
	).toBe('▸ LOCAL');
	expect(
		await ui.find({ type: 'Button', key: 'row:user:user:gac' }),
	).toBeUndefined();
	expect(
		(await ui.find({ type: 'Button', key: 'fold:group:tools' }))?.text,
	).toMatch(/^▸ tools/);

	await ui.press({ key: 'section:local' });
	expect(
		(await ui.find({ type: 'Button', key: 'row:user:user:gac' }))?.text,
	).toBe('▸ gac');
	await ui.unmount();
});

test('an expanded skill lists its details under labels', async ($, on) => {
	engine(on);
	const ui = await mount($);
	await ui.press({ key: 'row:user:user:gac' });
	expect((await ui.find({ type: 'Text', text: 'Source' }))?.text).toBe(
		'Source',
	);
	expect(
		(await ui.find({ type: 'Text', text: 'Made in your skills folder' }))
			?.text,
	).toBe('Made in your skills folder');
	expect(
		(await ui.find({ type: 'Text', text: /tokens every session/ }))?.text,
	).toMatch(/^≈ \d+ tokens every session$/);
	await ui.unmount();
});

test('Turn off sets the skill "off" and shows it before Claude Code reloads', async ($, on) => {
	const state = engine(on, withSettings(SETTINGS_TEXT));
	const ui = await mount($);
	await ui.press({ key: 'row:user:user:gac' });
	await ui.press({ key: 'turn-off:user:user:gac' });

	const written = JSON.parse(state.writes[USER_SETTINGS] ?? '{}');
	expect(written.skillOverrides).toEqual({
		cr: 'off',
		ghost: 'off',
		gac: 'off',
	});
	expect(written.env).toEqual({ SECRET_TOKEN: 'keep-me' });
	expect(
		(await ui.find({ type: 'Button', key: 'turn-on:user:user:gac' }))?.text,
	).toBe('Turn on');
	expect(
		await ui.find({ type: 'Button', key: 'insert:user:user:gac' }),
	).toBeUndefined();
	await ui.unmount();
});

test('Cancel drops a waiting confirm, and so does closing the row', async ($, on) => {
	const state = engine(on);
	const ui = await mount($);
	await ui.press({ key: 'row:user:user:broken' });
	await ui.press({ key: 'remove:user:user:broken' });
	await ui.press({ key: 'cancel:user:user:broken' });
	expect(
		await ui.find({
			type: 'Button',
			key: 'confirm-remove:user:user:broken',
		}),
	).toBeUndefined();
	expect(
		(await ui.find({ type: 'Button', key: 'remove:user:user:broken' }))
			?.text,
	).toBe('Remove link');

	await ui.press({ key: 'remove:user:user:broken' });
	await ui.press({ key: 'row:user:user:broken' });
	await ui.press({ key: 'row:user:user:broken' });
	expect(
		await ui.find({
			type: 'Button',
			key: 'confirm-remove:user:user:broken',
		}),
	).toBeUndefined();
	expect(state.runs.some((argv) => argv[0] === 'rm')).toBe(false);
	await ui.unmount();
});

test('a finished action says so at the top of the pane', async ($, on) => {
	engine(on, withSettings(SETTINGS_TEXT), {
		...SETTINGS,
		skillOverrides: { cr: 'off', ghost: 'off' },
	});
	const ui = await mount($);
	await ui.press({ key: 'row:user:user:cr' });
	await ui.press({ key: 'turn-on:user:user:cr' });
	expect((await ui.find({ type: 'Text', text: /Turned cr on/ }))?.text).toBe(
		'✓ Turned cr on',
	);
	await ui.unmount();
});

test("Uninstall plugin runs the desktop app's own claude first", async ($, on) => {
	const bundled = `${HOME}/Library/Application Support/Claude/claude-code/2.1.317/abc/claude.app/Contents/MacOS/claude`;
	const state = engine(on, {
		...FILES,
		[`${HOME}/Library/Application Support/Claude/claude-code`]: {
			kind: 'dir',
		},
		[`${HOME}/Library/Application Support/Claude/claude-code/2.1.317`]: {
			kind: 'dir',
		},
		[`${HOME}/Library/Application Support/Claude/claude-code/2.1.317/abc`]:
			{ kind: 'dir' },
		[bundled]: { kind: 'file', text: '' },
		...skillAt(
			'hidden',
			skill('hidden', "A local copy of the disabled plugin's skill."),
		),
	});
	const ui = await mount($);
	await ui.press({ key: 'row:user:user:hidden' });
	await ui.press({ key: 'uninstall:user:user:hidden' });
	await ui.press({ key: 'confirm-uninstall:user:user:hidden' });

	expect(state.runs).toContainEqual([
		bundled,
		'plugin',
		'uninstall',
		'disabled@market',
	]);
	expect(state.runs.some((argv) => argv[0] === 'claude')).toBe(false);
	await ui.unmount();
});

test('each plugin shows its author', async ($, on) => {
	engine(on);
	const ui = await mount($);
	expect(await ui.find({ type: 'Text', text: /Tool Maker/ })).toBeUndefined();
	await ui.press({ key: 'fold:group:tools' });
	expect((await ui.find({ type: 'Text', text: /Tool Maker/ }))?.text).toMatch(
		/^v1\.2\.0 · by Tool Maker · ≈ \d+ tokens each session$/,
	);
	await ui.unmount();
});

test('the Off chip includes claude.ai account skills that are off', async ($, on) => {
	engine(on, FILES, {
		...SETTINGS,
		skillOverrides: { cr: 'off', 'anthropic-skills:pdf': 'off' },
	});
	const ui = await mount($);
	expect((await ui.find({ type: 'Button', key: 'chip:off' }))?.text).toBe(
		'Off 2',
	);
	await ui.press({ key: 'chip:off' });
	expect(
		(await ui.find({ type: 'Button', key: 'row:synced:account:pdf' }))
			?.text,
	).toBe('▸ pdf');
	await ui.unmount();
});

test('only your own account skills link to claude.ai, and say so', async ($, on) => {
	const state = engine(on);
	const ui = await mount($);
	await ui.press({ key: 'chip:synced' });

	await ui.press({ key: 'row:synced:account:pdf' });
	expect((await ui.find({ type: 'Text', text: /every account/ }))?.text).toBe(
		'From Anthropic, on every account',
	);
	expect(
		await ui.find({ type: 'Button', key: 'account:synced:account:pdf' }),
	).toBeUndefined();

	await ui.press({ key: 'row:synced:account:cr' });
	expect(
		(await ui.find({ type: 'Text', text: 'Your claude.ai skill' }))?.text,
	).toBe('Your claude.ai skill');
	expect(
		(await ui.find({ type: 'Button', key: 'account:synced:account:cr' }))
			?.text,
	).toBe('Skills ↗');
	await ui.press({ key: 'account:synced:account:cr' });
	expect(state.runs).toContainEqual([
		'open',
		'claude://claude.ai/customize/skills/yours',
	]);
	expect(state.fills).toEqual([]);
	await ui.unmount();
});

test('an expanded plugin links to its page, and its commands show their source', async ($, on) => {
	const state = engine(on);
	const ui = await mount($);
	await ui.press({ key: 'fold:group:tools' });
	expect(
		await ui.find({ type: 'Button', key: 'plugin-page:tools' }),
	).toBeUndefined();
	await ui.press({ key: 'row:plugin:tools:plan' });
	await ui.press({ key: 'plugin-page:plugin:tools:plan' });
	expect(state.runs).toContainEqual([
		'open',
		'claude://claude.ai/customize/plugins/tools%40market',
	]);

	await ui.press({ key: 'fold:group:mover' });
	await ui.press({ key: 'row:command:mover:move-me' });
	await ui.press({ key: 'plugin-page:command:mover:move-me' });
	expect(state.runs).toContainEqual([
		'open',
		'claude://claude.ai/customize/plugins/yours',
	]);
	expect(
		(await ui.find({ type: 'Text', text: 'mover plugin · local folder' }))
			?.text,
	).toBe('mover plugin · local folder');
	await ui.unmount();
});

test('a command registered in code shows it costs nothing in context', async ($, on) => {
	engine(on);
	const ui = await mount($);
	await ui.press({ key: 'fold:group:mover' });
	await ui.press({ key: 'row:command:mover:move-me' });
	expect((await ui.find({ type: 'Text', text: /not in Claude/ }))?.text).toBe(
		"None: not in Claude's context",
	);
	expect(
		(await ui.find({ type: 'Text', text: '/dev/mover/hooks/register.tsx' }))
			?.text,
	).toBe('/dev/mover/hooks/register.tsx');
	await ui.unmount();
});

test('only Local and Project skills get VS Code and Finder', async ($, on) => {
	engine(on);
	const ui = await mount($);
	await ui.press({ key: 'row:user:user:gac' });
	expect(
		(await ui.find({ type: 'Button', key: 'edit:user:user:gac' }))?.text,
	).toBe('VS Code ↗');
	expect(
		(await ui.find({ type: 'Button', key: 'reveal:user:user:gac' }))?.text,
	).toBe('Finder ↗');

	await ui.press({ key: 'fold:group:tools' });
	await ui.press({ key: 'row:plugin:tools:plan' });
	expect(
		await ui.find({ type: 'Button', key: 'edit:plugin:tools:plan' }),
	).toBeUndefined();
	expect(
		await ui.find({ type: 'Button', key: 'reveal:plugin:tools:plan' }),
	).toBeUndefined();

	await ui.press({ key: 'fold:group:mover' });
	await ui.press({ key: 'row:command:mover:move-me' });
	expect(
		await ui.find({ type: 'Button', key: 'edit:command:mover:move-me' }),
	).toBeUndefined();
	expect(
		await ui.find({ type: 'Button', key: 'reveal:command:mover:move-me' }),
	).toBeUndefined();
	expect(
		(
			await ui.find({
				type: 'Button',
				key: 'plugin-page:command:mover:move-me',
			})
		)?.text,
	).toBe('Plugins ↗');
	await ui.unmount();
});

test('a project skill is listed under Project, with no Trash', async ($, on) => {
	engine(on, {
		...FILES,
		'/project/.claude/skills': { kind: 'dir' },
		'/project/.claude/skills/deploy-check': { kind: 'dir' },
		'/project/.claude/skills/deploy-check/SKILL.md': {
			kind: 'file',
			text: skill(
				'deploy-check',
				'Check a deploy before it goes out, for this repo only.',
			),
		},
	});
	const ui = await mount($);
	expect(
		await ui.find({ type: 'Text', text: 'None in this project.' }),
	).toBeUndefined();
	await ui.press({ key: 'row:project:project:deploy-check' });
	expect(
		(await ui.find({ type: 'Text', text: /shared with everyone/ }))?.text,
	).toBe('project repo · shared with everyone who clones it');
	for (const [key, label] of [
		['insert', 'Insert'],
		['edit', 'VS Code ↗'],
		['reveal', 'Finder ↗'],
		['turn-off', 'Turn off'],
	]) {
		expect(
			(
				await ui.find({
					type: 'Button',
					key: `${key}:project:project:deploy-check`,
				})
			)?.text,
		).toBe(label);
	}
	expect(
		await ui.find({
			type: 'Button',
			key: 'delete:project:project:deploy-check',
		}),
	).toBeUndefined();
	await ui.press({ key: 'chip:project' });
	expect(
		(
			await ui.find({
				type: 'Button',
				key: 'row:project:project:deploy-check',
			})
		)?.text,
	).toBe('▾ deploy-check');
	await ui.unmount();
});

test('a project skill with a problem gets no fixes that write, and Turn on leaves repo settings alone', async ($, on) => {
	const state = engine(
		on,
		{
			...FILES,
			'/project/.claude/skills': { kind: 'dir' },
			'/project/.claude/skills/bare': { kind: 'dir' },
			'/project/.claude/skills/bare/SKILL.md': {
				kind: 'file',
				text: 'No frontmatter here.\n',
			},
			'/project/.claude/settings.json': {
				kind: 'file',
				text: '{\n  "skillOverrides": { "bare": "off" }\n}\n',
			},
		},
		{ ...SETTINGS, skillOverrides: { bare: 'off' } },
	);
	const ui = await mount($);
	await ui.press({ key: 'row:project:project:bare' });
	expect(
		await ui.find({
			type: 'Button',
			key: 'frontmatter:project:project:bare',
		}),
	).toBeUndefined();
	await ui.press({ key: 'turn-on:project:project:bare' });
	expect(state.writes['/project/.claude/settings.json']).toBeUndefined();
	expect(
		(await ui.find({ type: 'Text', text: /doesn't change repo files/ }))
			?.text,
	).toMatch(/bare is turned off in this project's \.claude\/settings\.json/);
	await ui.unmount();
});

test('a newer plugin version shows with an Update button that updates it through Claude Code', async ($, on) => {
	const RAW = 'https://raw.githubusercontent.com';
	WEB = {
		[`${RAW}/owner/market/HEAD/.claude-plugin/marketplace.json`]:
			JSON.stringify({
				plugins: [
					{
						name: 'tools',
						source: { source: 'github', repo: 'owner/tools' },
					},
				],
			}),
		[`${RAW}/owner/tools/HEAD/.claude-plugin/plugin.json`]:
			'{"name":"tools","version":"1.3.0"}',
	};
	const state = engine(on, {
		...FILES,
		[`${HOME}/.claude/plugins/known_marketplaces.json`]: {
			kind: 'file',
			text: JSON.stringify({
				market: { source: { source: 'github', repo: 'owner/market' } },
			}),
		},
	});
	const ui = await mount($);

	expect((await ui.find({ type: 'Text', text: /is out/ }))?.text).toBe(
		'⬆ tools 1.3.0 is out (you have 1.2.0)',
	);
	expect((await ui.find({ type: 'Text', text: /available$/ }))?.text).toBe(
		'⬆ 1.3.0 available',
	);
	await ui.press({ key: 'update:tools@market' });
	expect(state.runs).toContainEqual([
		'claude',
		'plugin',
		'marketplace',
		'update',
		'market',
	]);
	expect(state.runs).toContainEqual([
		'claude',
		'plugin',
		'update',
		'tools@market',
	]);
	expect(await ui.find({ type: 'Text', text: /is out/ })).toBeUndefined();
	WEB = {};
	await ui.unmount();
});

test('an older or non-numbered remote version is never shown as an update', async ($, on) => {
	const RAW = 'https://raw.githubusercontent.com';
	WEB = {
		[`${RAW}/owner/market/HEAD/.claude-plugin/marketplace.json`]:
			JSON.stringify({
				plugins: [{ name: 'tools', version: 'abc123' }],
			}),
	};
	engine(on, {
		...FILES,
		[`${HOME}/.claude/plugins/known_marketplaces.json`]: {
			kind: 'file',
			text: JSON.stringify({
				market: { source: { source: 'github', repo: 'owner/market' } },
			}),
		},
	});
	const ui = await mount($);
	expect(await ui.find({ type: 'Text', text: /is out/ })).toBeUndefined();
	WEB = {};
	await ui.unmount();
});

test('/loadout opens the pane with the keyboard, so it can be used at once', async ($, on) => {
	const state = engine(on);
	await $.session.start({
		cwd: '/project',
		surface: 'terminal',
		isInteractive: true,
	});
	const { text } = await $.command.run({ command: 'loadout' });

	expect(state.opens).toEqual([
		expect.objectContaining({ id: 'loadout', focus: true }),
	]);
	expect(text).toBe('Loadout opened.');
});

test('/loadout says why when the pane could not be placed', async ($, on) => {
	const state = engine(on);
	state.notPlaced = 'no-surface';
	await $.session.start({
		cwd: '/project',
		surface: 'terminal',
		isInteractive: true,
	});
	const { text } = await $.command.run({ command: 'loadout' });

	expect(text).toMatch(/no-surface/);
});

test('the focused pane starts its ring on the search box, so typing searches at once', async ($, on) => {
	engine(on);
	const ui = await mount($, 'terminal');

	const focused = [
		...(await ui.findAll({ type: 'Button' })),
		...(await ui.findAll({ type: 'Input' })),
	].filter((element) => element.props.autoFocus === true);
	expect(focused.map((element) => element.key)).toEqual(['search']);
	await ui.unmount();
});

test('typing in the search box narrows every section to the matches', async ($, on) => {
	engine(on);
	const ui = await mount($, 'terminal');
	await ui.input({ key: 'search', text: 'commit', kind: 'change' });

	// gac matches by its description; cr does not.
	expect(
		await ui.find({ type: 'Button', key: 'row:user:user:gac' }),
	).toBeDefined();
	expect(
		await ui.find({ type: 'Button', key: 'row:user:user:cr' }),
	).toBeUndefined();
	expect(await ui.find({ type: 'Button', text: /pdf/ })).toBeUndefined();
	await ui.unmount();
});

test('a match inside a folded plugin shows without opening the fold', async ($, on) => {
	engine(on);
	const ui = await mount($, 'terminal');
	await ui.input({ key: 'search', text: 'PLAN', kind: 'change' });

	expect((await ui.find({ type: 'Button', text: /plan/ }))?.text).toMatch(
		/plan/,
	);
	expect(
		await ui.find({ type: 'Button', key: 'row:user:user:gac' }),
	).toBeUndefined();
	await ui.unmount();
});

test('a search with no match says so', async ($, on) => {
	engine(on);
	const ui = await mount($, 'terminal');
	await ui.input({ key: 'search', text: 'zzz-nothing', kind: 'change' });
	expect(
		(await ui.find({ type: 'Text', text: /Nothing matches/ }))?.text,
	).toMatch(/zzz-nothing/);
	await ui.unmount();
});

test('Clear follows the search box while there is a search, and empties it', async ($, on) => {
	engine(on);
	const ui = await mount($, 'terminal');
	expect(
		await ui.find({ type: 'Button', key: 'search-clear' }),
	).toBeUndefined();

	await ui.input({ key: 'search', text: 'commit', kind: 'change' });
	const clear = await ui.find({ type: 'Button', key: 'search-clear' });
	expect(clear?.text).toBe('Clear');
	const keys = [
		...(await ui.findAll({ type: 'Input' })),
		...(await ui.findAll({ type: 'Button' })),
	].map((element) => element.key);
	expect(keys).toContain('search');

	await ui.press({ key: 'search-clear' });
	expect(
		await ui.find({ type: 'Button', key: 'row:user:user:cr' }),
	).toBeDefined();
	expect(
		await ui.find({ type: 'Button', key: 'search-clear' }),
	).toBeUndefined();
	expect(
		(await ui.find({ type: 'Input', key: 'search' }))?.props.submitLabel,
	).toBe('');
	await ui.unmount();
});

test('Enter, which empties the box, clears the search with it', async ($, on) => {
	engine(on);
	const ui = await mount($, 'terminal');
	await ui.input({ key: 'search', text: 'commit', kind: 'change' });
	await ui.input({ key: 'search', text: 'commit', kind: 'submit' });

	// cr does not match `commit`; with the search cleared it shows again.
	expect(
		await ui.find({ type: 'Button', key: 'row:user:user:cr' }),
	).toBeDefined();
	await ui.unmount();
});

test('/loadout starts with an empty search', async ($, on) => {
	engine(on);
	const ui = await mount($, 'terminal');
	await ui.input({ key: 'search', text: 'commit', kind: 'change' });
	await $.command.run({ command: 'loadout' });

	expect(
		await ui.find({ type: 'Button', key: 'row:user:user:cr' }),
	).toBeDefined();
	await ui.unmount();
});

const arrow = (by: number) => ({ origin: { kind: 'person' as const }, by });
const RING = ['Refresh', 'chip:local', 'row:a', 'row:b'];

test('the arrows walk the ring a step at a time', () => {
	expect(ringStep(arrow(1), RING, 'chip:local')).toBe('row:a');
	expect(ringStep(arrow(-1), RING, 'row:a')).toBe('chip:local');
	// Off the ring, or on nothing, the arrows land on its first stop.
	expect(ringStep(arrow(1), RING, undefined)).toBe('Refresh');
	expect(ringStep(arrow(1), RING, 'gone')).toBe('Refresh');
});

test('past either end, and for the wheel or page keys, the window scrolls', () => {
	expect(ringStep(arrow(1), RING, 'row:b')).toBeUndefined();
	expect(ringStep(arrow(-1), RING, 'Refresh')).toBeUndefined();
	const wheel = { ...arrow(1), pointer: { row: 3, column: 4 } };
	expect(ringStep(wheel, RING, 'row:a')).toBeUndefined();
	expect(ringStep(arrow(12), RING, 'row:a')).toBeUndefined();
	expect(
		ringStep({ origin: { kind: 'plugin' }, by: 1 }, RING, 'row:a'),
	).toBeUndefined();
	expect(ringStep(arrow(1), [], undefined)).toBeUndefined();
});

test('in the terminal, a pane without the keyboard says how to get it back', async ($, on) => {
	engine(on);
	const ui = await mount($, 'terminal');
	expect(
		(await ui.find({ type: 'Text', text: /ctrl\+x tab/ }))?.text,
	).toMatch(/\/loadout/);

	await ui.redraw({ ...PANE.props, isFocused: true });
	expect(
		await ui.find({ type: 'Text', text: /ctrl\+x tab/ }),
	).toBeUndefined();
	await ui.unmount();
});

test('on the main screen /loadout names the setting that docks it beside the chat', async ($, on) => {
	engine(on);
	await $.session.start({
		cwd: '/project',
		surface: 'terminal',
		isInteractive: true,
	});
	const main = await $.command.run({
		command: 'loadout',
		presentation: { isFullscreen: false, columns: 95 },
	} as Parameters<typeof $.command.run>[0]);
	expect(main.text).toMatch(/\/tui fullscreen/);

	const full = await $.command.run({
		command: 'loadout',
		presentation: { isFullscreen: true, columns: 140 },
	} as Parameters<typeof $.command.run>[0]);
	expect(full.text).toBe('Loadout opened.');
});
