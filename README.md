<h1 align="center">
	<picture>
		<source media="(prefers-color-scheme: dark)" srcset="docs/brand/banner-dark.svg">
		<img alt="loadout" src="docs/brand/banner-light.svg" width="720">
	</picture>
</h1>

See everything Claude Code has equipped in one pane: your own skills, the project's, every enabled plugin, and the skills on your claude.ai account. For each skill you get what it does, where it lives, and whether it's turned off. One click puts its command in the prompt box.

## Why use it

> [!TIP]
> **Browsing your loadout uses zero tokens.** Asking Claude "what skills do I have?" spends tokens on every answer. loadout reads your skill folders locally and never calls the model.

The desktop app's **Customize → Skills** page only lists your claude.ai account skills. Skills in `~/.claude/skills`, a project's `.claude/skills` and plugins don't show up there. loadout lists them all:

- **Every source, grouped**:
  - **Local**: `~/.claude/skills`
  - **Project**: `.claude/skills`
  - **Plugins**: each enabled plugin, including ones loaded from `CLAUDE_CODE_PLUGIN_DIRS`, with its skills and its slash commands, even ones a mod registers in code
  - **claude.ai account**: only the account skills that are turned on
- **Filter chips**: All, Local, Plugins, Project, Synced, Off, Issues
- **Details**: an expanded skill lists its **File**, its **Cost** and its **Source** (e.g. `npx skills · typesafe-ai/skills · Oct 29, 2026` or `superpowers plugin · claude-plugins-official marketplace`) in labelled lines
- **Collapsible sections**: click a section heading (Local, Plugins, Project, …) to close or open it
- **What each skill does**: a one-line summary from its `SKILL.md`, expanded to the full description with a click
- **Off at a glance**: skills set to `"off"` in `skillOverrides` are dimmed and tagged **OFF**
- **Problems flagged** (⚠, counted under **Issues**):
  - the same skill name in more than one place, including a skill a disabled plugin also ships
  - no frontmatter, or no description
  - a broken symlink, or a folder with no `SKILL.md`
  - a file `SKILL.md` links to that isn't there
  - a description over 1,024 characters
  - a name that isn't lowercase letters, digits and hyphens, or that differs from its folder
  - `skill.md` in lowercase, which works on a Mac and is missed on Linux
  - a name a built-in command already has, like `/init`
  - a `skillOverrides` entry for a skill that no longer exists
- **Hints** (ⓘ, dimmed, not counted): a very short description, a `SKILL.md` over 500 lines, no instructions under the frontmatter
- **Token cost**: roughly what each skill's description costs, since every session carries it, and the total across the skills that are on
- **Fix buttons on flagged skills**:
  - broken symlink: **Remove link**, after you confirm, and **Finder ↗**
  - no `SKILL.md`: **Create SKILL.md**, a starter file opened in VS Code
  - no description: **VS Code ↗**
  - no frontmatter: **Add frontmatter**, a starter header above the existing text
  - lowercase `skill.md`: **Rename to SKILL.md**
  - duplicate: **Ask Claude**, which puts a question about the two copies in the prompt box
  - also in a disabled plugin: **Uninstall <plugin> plugin**, after you confirm. It runs Claude Code's own `claude plugin uninstall`, using the copy of Claude Code the desktop app ships (or `claude` on your PATH), and, when it's that marketplace's last plugin, removes the marketplace too
  - stale `skillOverrides` entry: **Remove from settings**
  - everything else: **VS Code ↗**
- **Insert**: puts the skill's command at the start of the prompt box, keeping what you typed after it. It never sends. Flagged skills show their fixes instead, and skills that are off have no Insert.
- **Turn on**: on a skill that is off, removes its `"off"` entry from `skillOverrides`, so it's on straight away.
- **Turn off**: on a skill that is on, sets it to `"off"` in `skillOverrides` of `~/.claude/settings.json`, the way `/skills` does. The files stay; Claude Code just stops using it until you **Turn on** again.
- **Uninstall / Delete shortcut / Move to Trash** (macOS): on any Local skill, after you confirm, takes the skill off your machine the way it got there. Unlike Turn off, the files go, to the Trash. A skill `npx skills` installed shows **Uninstall**: its shared folder in `~/.agents/skills` moves to the Trash, Claude Code's shortcut is deleted and its entry leaves `~/.agents/.skill-lock.json`. No Node or `npx` is needed; other tools' shortcuts to it, if any, stop working. A shortcut (symlink) shows **Delete shortcut**, which deletes only the shortcut. A real folder shows **Trash**. Its `"off"` entry is removed too.
- **Confirmations**: anything that removes something (Uninstall, Delete shortcut, Move to Trash, Remove link, Uninstall plugin) asks first in Claude Code's own dialog. Where that dialog can't open, for example while Claude is mid-turn, the row shows an inline confirm with **Cancel** instead.
- **What just happened** shows as a line at the top of the pane ("✓ Turned typesafe-ai on") for a few seconds.
- **If Claude Code can't be run** for Uninstall plugin, the command is copied for you to paste into a terminal instead.
- **VS Code ↗** (Local and Project skills): opens the skill's `SKILL.md` in VS Code, or in your default text editor when VS Code isn't installed
- **Finder ↗** (Local and Project skills): shows the skill's folder in Finder
- **Usage counts**: how often each skill ran and when it last did, kept across sessions

## Requirements

- Claude Code 2.1.317 or newer: the desktop app's Code tab, or the CLI
- macOS for the claude.ai account section, **VS Code ↗**, **Finder ↗** and the Uninstall / Delete shortcut / Move to Trash button. Everything else works anywhere.

## Install

In a Claude Code terminal session:

```bash
/plugin install loadout --marketplace webdevnerdstuff/claude-loadout
```

Answer `y` to add the marketplace, then pick **user** scope so it loads in every session, including the desktop app's.

### Update and remove

To update, refresh the marketplace, then update the plugin and restart Claude Code:

```bash
claude plugin marketplace update claude-loadout
```

```bash
claude plugin update loadout@claude-loadout
```

To remove it:

```bash
claude plugin uninstall loadout@claude-loadout
```

## Use

1. Run `/loadout` in any session. The **Loadout** pane opens.
2. Pick a chip to narrow the list, or stay on **All**.
3. Click a skill to read its full description and see where its file lives.
4. In an expanded skill, click **Insert** to start a prompt with it, or **VS Code ↗** to edit it.

**Refresh** reads the folders again. The pane also rescans each time you run `/loadout`. Plugins register their commands as a session starts, so a command added after the first scan shows after a refresh.

## Where it looks

| Section | Read from |
| --- | --- |
| Local | `~/.claude/skills/*/SKILL.md`, symlinks followed, except `synced/` |
| Project | `<project>/.claude/skills/*/SKILL.md` |
| Plugins | `~/.claude/plugins/installed_plugins.json` for the plugins `enabledPlugins` turns on, plus each folder in `CLAUDE_CODE_PLUGIN_DIRS`. Their `skills/` folders and any `skills` paths in their `plugin.json`, and the commands Claude Code lists for each plugin |
| claude.ai account | The desktop app's own copy of your account skills, `~/Library/Application Support/Claude/local-agent-mode-sessions/skills-plugin/<org>/<account>/manifest.json`. Only skills with `enabled: true` are listed |
| OFF | `skillOverrides` in your merged settings |

> [!NOTE]
> **Turn on**, **Turn off**, the remove buttons and **Remove from settings** only ever edit `skillOverrides` in your own `~/.claude/settings.json`. **Loadout never writes inside a repo**: if a skill is turned off in a project's `.claude/settings.json` or `.claude/settings.local.json`, the pane says so and leaves it. Fix buttons that write files (Create SKILL.md, Add frontmatter, Rename, Remove link) are for Local skills only. Only those entries change: the rest of the file, its key order and its indentation stay as they were, and the file is read back to check it's still valid JSON. Loadout reads the file on your machine only: its contents never go to Claude.

> [!NOTE]
> `~/.claude/skills/synced/` is an older copy of your account skills that the app stops updating. loadout reads the app's current copy instead, so a skill you removed from your account doesn't linger. That folder is the app's own and undocumented. If an update moves it, the claude.ai account section shows none until loadout catches up.

Usage counts are kept in the plugin's own store. They start at zero when you install it: Claude Code keeps no history of past skill runs.

## Develop

```bash
pnpm check  # validates the manifests and runs the engine tests
```

Load it from the folder while you work on it: `claude --plugin-dir .`. See [AGENTS.md](AGENTS.md) for how it is put together.

## License

MIT © WebDevNerdStuff
