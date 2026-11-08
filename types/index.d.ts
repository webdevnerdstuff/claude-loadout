export type SkillSource = 'user' | 'project' | 'plugin' | 'synced';

export type ProblemCode =
	| 'broken-link'
	| 'no-skill-md'
	| 'no-description'
	| 'duplicate'
	| 'no-frontmatter'
	| 'broken-ref'
	| 'long-description'
	| 'bad-name'
	| 'name-mismatch'
	| 'lowercase-file'
	| 'shadowed'
	| 'vague-description'
	| 'long-file'
	| 'empty-body';

/** A hint is drawn dimmed and left out of the Issues count. */
export type SkillProblem = { code: ProblemCode; text: string; isHint?: true };

/** A disabled plugin, as `claude plugin uninstall` and `marketplace remove` name it. */
export type OffPlugin = {
	name: string;
	key: string;
	marketplace: string;
	isLastFromMarketplace: boolean;
};

/** Newer versions found for installed plugins, by `name@marketplace`. */
export type PluginUpdates = Record<string, { current: string; latest: string }>;

/** The line at the top of the pane that says what an action just did. */
export type PaneNotice = { text: string; isError: boolean; at: number };

/** A `skillOverrides` key that names no skill Loadout found. */
export type StaleOverride = { key: string; value: string };

export type SkillEntry = {
	id: string;
	name: string;
	description: string;
	source: SkillSource;
	group: string;
	path: string;
	/** The skill's folder, absolute: what a fix acts on. */
	folder?: string;
	file?: string;
	slash: string;
	linkTarget?: string;
	isOff: boolean;
	problems: SkillProblem[];
	/** Roughly what its description costs in every session's context. */
	tokens?: number;
	/** The name of a lowercase `skill.md` to rename, when that is what it has. */
	lowercaseFile?: string;
	/** Where the skill came from, in words: an installer, a plugin, a link. */
	origin?: string;
	/** The name `npx skills` installed it under, when it did. */
	npxName?: string;
	/** A claude.ai account skill the person made, as opposed to one Anthropic gives every account. */
	isAccountOwn?: boolean;
	/** Which group a claude.ai account skill is drawn in. */
	accountGroup?: 'yours' | 'examples' | 'documents' | 'builtin';
	/** A disabled plugin that ships a skill of the same name. */
	offPlugin?: OffPlugin;
	/** Set on a plugin's slash command, which is listed beside its skills. */
	kind?: 'command';
};

export type SkillFilter =
	| 'local'
	| 'user'
	| 'project'
	| 'plugin'
	| 'off'
	| 'issues'
	| 'synced';

export type PluginInfo = {
	name: string;
	origin: 'marketplace' | 'dev folder';
	path: string;
	/** The plugin's folder, absolute. */
	root?: string;
	version?: string;
	author?: string;
	marketplace?: string;
	description?: string;
	skillCount: number;
	commandCount: number;
};

export type SkillScan = {
	skills: SkillEntry[];
	plugins: PluginInfo[];
	commands: SkillEntry[];
	staleOverrides: StaleOverride[];
	/** Delete moves folders to the macOS Trash, so it is offered on a Mac only. */
	isMac: boolean;
	userDir: string;
	projectDir: string;
	scannedAt: number;
	syncedAt?: number;
};

export type SkillUsage = Record<string, { count: number; last: number }>;

declare module 'claude-code' {
	interface PluginState {
		loadout: {
			scan: Shaped<SkillScan | null>;
			open: Shaped<string[]>;
			filter: Shaped<SkillFilter>;
			query: Shaped<string>;
			usage: Shaped<SkillUsage>;
			confirm: Shaped<string>;
			cleared: Shaped<string[]>;
			turnedOff: Shaped<string[]>;
			notice: Shaped<PaneNotice | null>;
			updates: Shaped<PluginUpdates>;
		};
	}
}
