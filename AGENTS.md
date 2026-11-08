# AGENTS.md

Guidance for AI agents and contributors working on this repository.

## What this is

`loadout` is a Claude Code **mod**: a plugin of function hooks (`hooks/hooks.json` names one hooks module, `hooks/register.tsx`). It draws a pane listing every skill and plugin Claude Code has: the user's own skills, the project's, enabled plugins, and the claude.ai account's. The repository is also its own marketplace (`.claude-plugin/marketplace.json`, source `./`).

The mod API is early access. Its declarations are the authority: Claude Code lays them in `.claude-plugin/types/claude-code/index.d.ts` each time it loads the plugin from this folder (git-ignored). Grep that file for an event or noun before using it.

## Layout

| Path | What |
| --- | --- |
| `.claude-plugin/plugin.json` | Manifest; `version` is the release version. The name may not start with `claude-` (reserved), so the plugin is `loadout` and the repo and marketplace keep `claude-loadout` |
| `.claude-plugin/marketplace.json` | Makes the repo installable with `/plugin install loadout --marketplace webdevnerdstuff/claude-loadout` |
| `hooks/register.tsx` | The hooks module: the scan, `session.start` (registers `/loadout`, loads usage), `command.run`, `skill.prompt` (counts runs) and `ui.render` on the `Pane` |
| `hooks/frontmatter.ts` | A small reader for a `SKILL.md`'s top-level frontmatter: plain, quoted, folded (`>`) and literal (`\|`) values. Pure, no `$` |
| `types/index.d.ts` | The plugin's contract: its `$.state` keys and the shapes they hold |
| `docs/demo/` | `pane.html`, a hand-drawn copy of the pane as the desktop app draws it (dark theme, colours and sizes measured from the real pane) with made-up skills, and `render.sh`, which renders it to the README's `docs/screenshot-dark.png`. Never screenshot a real pane for it: real skills are personal. Update it when the pane's look changes |
| `tests/pane.test.tsx` | `claude plugin test` suite: a fake machine answered by hooks, the pane mounted on it |

## Commands

```bash
pnpm validate  # claude plugin validate .
pnpm test      # claude plugin test .
pnpm check     # both
pnpm format    # prettier --write .
```

Run `pnpm check` before every commit, with Claude Code 2.1.317 or newer on `PATH`. An older CLI refuses props the pane uses (`Text`'s `size`, for one) and every test fails. A type-check needs the types Claude Code lays when it loads the plugin: `claude --plugin-dir .` once, then `npx tsc -p .`.

## How the scan works

`scanSkills` runs on `session.start`, on `/loadout` and on **Refresh**, and writes one `SkillScan` to `$.state` (`loadout.scan`). The pane only reads state.

- **Local**: `~/.claude/skills/<dir>/SKILL.md`, skipping `synced/`. A symlinked folder records where it points. A broken link or a folder with no `SKILL.md` is still listed, with a problem.
- **Project**: `$.session.root()` + `/.claude/skills`.
- **Plugins**: `~/.claude/plugins/installed_plugins.json`, keeping entries `enabledPlugins` sets to `true` (user scope, or a project entry for this project), plus every folder in `CLAUDE_CODE_PLUGIN_DIRS` (`:`-separated). Skills come from `skills/` and any `skills` paths in the plugin's `plugin.json`. A plugin with no skills is still listed.
- **Plugin commands**: `$.command.list()`, the `plugin` source entries whose `plugin` is a listed plugin's name (`commandsOf`). A mod's `$.command.register` commands are in no file, so this is the only way to see them. The plugin's own skills come back as commands too and are dropped. They are kept in `SkillScan.commands`, apart from `skills`, so skill counts and chips count skills only.
- **claude.ai account**: the desktop app's current copy, `~/Library/Application Support/Claude/local-agent-mode-sessions/skills-plugin/<org>/<account>/manifest.json`, keeping `enabled: true` skills. `~/.claude/skills/synced/` is an older copy the app stops updating: never read it. This location is undocumented. Keep the code tolerant of it being missing.
- **Off**: `skillOverrides` from `$.settings.read({ key })`, `"off"` under the skill's name: `<plugin>:<name>` for plugins, `anthropic-skills:<name>` for the account's.
- **Problems**: `checkSkill` (frontmatter, description length, name rules, hints) and `missingRefs` (relative `[text](path)` links) per skill, a lowercase `skill.md` from the folder listing, then `flagDuplicates` ("Also in …") and `flagShadowed` (a bare name a `builtin` command has). A hint (`isHint`) is drawn dimmed and never counted under Issues.
- **Origins**: `withOrigin` reads `~/.agents/.skill-lock.json` (what `npx skills` installed) for Local and Project skills; plugin skills say their plugin and marketplace. Disabled plugins' skills are scanned only for their names (`offCopies`), so a local skill of the same name is flagged with an `offPlugin` to uninstall.
- **Plugin updates**: `checkForUpdates` runs on `session.start` (once a day, stamped in `$.store` before fetching) and on Refresh (forced). It reads each marketplace's `marketplace.json` from `raw.githubusercontent.com/<repo>/HEAD`, resolves the plugin's `plugin.json` the way its entry points (folder of the marketplace repo, `github` repo, or a `url` pinned to a `sha`), and keeps only plain `x.y.z` versions newer than installed (`isNewer`). It never installs anything itself; **Update** runs `claude plugin marketplace update` + `claude plugin update` through `runClaude`.
- **Stale overrides**: `skillOverrides` keys matching no skill's name or command (`staleIn`).
- **Tokens**: `tokensOf(name + description)`, about four characters a token, summed over skills that are on.

Usage counts live in `$.store` (`usage`, keyed by the skill's command without the slash), mirrored into `$.state` (`loadout.usage`) so the pane redraws.

## Rules to keep

- **Settings: read one key, write one entry.** Settings hold secrets. Read them with `$.settings.read({ key })`. The only write is `removeOverrides`: it reads a settings file, deletes `skillOverrides` entries, writes it back with the file's own indentation, parses it again, and restores the original if that fails. The text never leaves that function: never log, store, toast or render it, and never send it to the model. Writes go to `~/.claude/settings.json` only.
- **Never write inside a repo.** Project skills and a project's `.claude/settings*.json` are read-only to Loadout; fixes that write are Local-only.
- **Write only what a button names.** Skill folders and manifests are read. Writes happen on a press: Create SKILL.md, Add frontmatter, Rename to SKILL.md, Remove link, Delete (to the Trash), and `skillOverrides` entries. Each one is checked first, and the deleting ones take a second click. Uninstall of an `npx skills` install is done by Loadout itself (`uninstallNpxSkill`): shared folder to the Trash, Claude's shortcut, its lock entry. It never runs `npx`.
- **Fixes touch only what they name.** Remove link checks the entry is a symlink and runs `rm` without `-r` after a second click. Create SKILL.md writes a new file only when none exists. Nothing else deletes or overwrites.
- **`claude` commands go through `runClaude`**: the desktop app's bundled Claude Code (`~/Library/Application Support/Claude/claude-code/<version>/<build>/claude.app/Contents/MacOS/claude`, newest first), then `claude` on the PATH, then `runOrCopy` copies it for a terminal. A desktop app's PATH usually reaches neither Homebrew nor nvm. The marketplace is removed only when the plugin was its last.
- **Insert never sends.** It fills the prompt box (`$.prompt.fill`, `replace`, the draft kept after the command) and falls back to the clipboard with a toast.
- **Bump a `shape` tag when a stored value's fields change** (`scan-5`, `usage-1`, …): it declines what an earlier version stored, which outlives a reload.

## Rules the mod loader enforces

These are refused at load, so `validate` catches them:

- **No `import()`**, no DOM and no Node in the module. Files, settings and processes are reached through `$`.
- **`$` is spelled `$.noun.method(...)` at the call site, and is followed only into functions of the same file**: never pass `$` into an imported module. That is why the scan lives in `register.tsx` and only the pure frontmatter reader is split out.
- **An `atom` takes a literal reference** (`{ plugin: 'loadout', key: 'k' }` written inline).
- **`$.env.get` takes a string literal.**
- **The type contract is self-contained**: `types/index.d.ts` has no `import`.
- **A render hook never writes state.** Write from a handler closure, `command.run`, `session.start` or `skill.prompt`.
- **The desktop drops styles inside a `Button`.** Keep colored tags (`OFF`, ⚠, the source dot) as `Text` beside the button, not inside it.

## Tests

- The pane goes through the engine: `$.ui.mount({ plugin: 'loadout', surface, component: 'Pane', requestId: 'loadout', props })`, with every `$.fs`, `$.settings`, `$.env`, `$.store` and `$.prompt` call answered by `engine()` in `tests/pane.test.tsx` from a fake file table. Never point a test at a real home folder.
- Find a Button by its `key` (`row:<id>`, `fold:<id>`, `chip:<filter>`, `search-clear`, `insert:<id>`, and the fixes `create:`, `remove:`, `confirm-remove:`, `reveal:`, `ask:`), and a Text by its words. Type into the search box with `ui.input({ key: 'search', text, kind: 'change' })`; the kit's default kind is `submit` (Enter), which clears the search. A command's id is `command:<plugin>:<name>`.

## Style

- Comments say what the code holds or why, in plain sentences; no restating the code.
- No `else` after a `return`.
- Named exports; `register` is the hooks module's entry.
- Prettier: tabs, semicolons, single quotes, trailing commas (`.prettierrc.json`).

## Git

- **Never commit** without an explicit "commit this".
- Commit messages: short and imperative.

## Releases

- Bump `version` in `.claude-plugin/plugin.json` and `package.json` in the PR that changes behaviour: `claude plugin update` compares it.
- After merging: tag `vX.Y.Z` on `main`, push the tag, and create a GitHub Release with generated notes (`gh release create vX.Y.Z --generate-notes`). There is no CHANGELOG file; the Releases page is the history.
