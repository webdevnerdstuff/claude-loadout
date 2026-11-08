import type { On } from 'claude-code';
import type { TestBody } from 'claude-code/testing';
import { expect, test } from 'claude-code/testing';

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
				{ name: 'pdf', description: 'Work with PDFs.', enabled: true },
				{
					name: 'cr',
					description: 'An account copy of cr.',
					enabled: true,
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

type Engine = {
	draft: string;
	fills: string[];
	stored: Record<string, unknown>;
	runs: string[][];
	writes: Record<string, string>;
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
	};
	on('command.register', () => ({ value: { command: 'loadout' } }));
	on('ui.open', () => ({ value: { isPlaced: true } }));
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
	expect(await ui.find({ type: 'Text', text: /dev folder/ })).toBeUndefined();
	await ui.press({ key: 'fold:group:mover' });
	expect((await ui.find({ type: 'Text', text: /dev folder/ }))?.text).toBe(
		'v0.1.0 · dev folder',
	);
	expect(await ui.find({ type: 'Text', text: /disabled/ })).toBeUndefined();
	expect(
		(await ui.find({ type: 'Button', key: 'fold:group:synced' }))?.text,
	).toBe('▸ Show synced account skills (2)');
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
	expect((await ui.find({ type: 'Text', text: /Tool Maker/ }))?.text).toBe(
		'v1.2.0 · by Tool Maker',
	);
	await ui.unmount();
});
