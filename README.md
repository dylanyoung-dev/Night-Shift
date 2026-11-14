# Night-Shift
Project Night Shift a tool to help me run/manage my Agentic Software Factory.

Electron app that shows the Linear board and the agent runs side by side, and runs scripted steps (worktree, `npm ci`, Linear moves) before handing off to Claude Code.

![Night Shift board: Linear columns for the AmplifyUP project, with a finished build run on IGN-488](docs/board.png)

## Run it

Needs Node 22 or later (tested on Node 24 with Electron 45) and Git. Electron downloads its binary the first time it runs.

```
npm install
npm run dev
```

## Install on another computer

1. Install [Node 22+](https://nodejs.org) and Git, then clone this repo.
2. Build the installer and run it:

   ```
   npm install
   npm run package
   ```

   This makes `dist\Night Shift Setup <version>.exe`. It installs for your user only (no admin needed) and adds Start menu and desktop shortcuts. To run it without installing, use `npm run package:dir` and open `dist\win-unpacked\Night Shift.exe`, or skip packaging and use `npm run dev`.
3. On the first computer, **Settings › Export settings** saves `night-shift-settings.yml`. Copy it over and use **Settings › Import settings**. It brings your projects and general settings (team, repo path, base branch, worktrees, run limits, hidden states), nothing else. If the repo path doesn't exist on the new machine, the local one is kept and you're told.
4. Paste your Linear API key in Settings. It's never in the exported file; each machine stores its own, encrypted for that Windows user.

The installed app and `npm run dev` share the same settings and run history.

## Base branch

The base branch changes every release. Click the **project · base &lt;branch&gt;** chip at the top of the board to pick another branch from the repo (**Fetch** pulls new ones from origin). It saves straight away.

Then open **Settings** and fill in:

- **Linear API key**: Linear › Settings › Security & access › Personal API keys. Stored encrypted with the OS keychain.
- **Linear team key**: e.g. `IGN`
- **Repo path**: the checkout agents work in, e.g. `C:\Development\auto-personalization-poc`
- **Base branch**: where new worktrees start, e.g. `releases/nov-2026`
- **New worktrees**: either Night Shift creates them at a path you choose (`$REPO/.claude/worktrees/$ID` by default; `$REPO`, `$ID`, `$TICKET`, `$BRANCH` are filled in), or the agent decides and Night Shift creates none. A state can override this with a `worktree:` block in `steps.yml`.

Settings live outside this repo, in `%APPDATA%\night-shift\settings.json` (Windows), next to run history in `runs\`. They survive rebuilds, `npm install` and fresh clones. The Linear API key is stored encrypted with Windows DPAPI, so the file can't be copied to another machine or user.

## Projects and filters

A **project** is a named slice of the team's tickets, linked to one or more Linear projects (Settings › Projects). Projects are listed under **Linear** in the left nav; picking one limits the board, and automatic runs, to tickets in its Linear projects. **All of team** shows everything. The choice is remembered.

The filter bar above the board narrows what's shown by ID or title, assignee, label and priority. Filters only change the view; they reset when you switch project.

## Steps

Steps are grouped into **sets**. A set runs for tickets in any of its Linear states, and a state can be in only one set. Create and edit sets on the **Steps per state** page; saving writes `.nightshift/steps.yml` in the repo agents work in (not this repo), so changes go through PRs. Without that file the built-in defaults are used. Older files with one block per state still load and are converted on the next save. See `.nightshift/steps.example.yml` for every option.

Each run:

1. Creates the worktree at the configured path on the ticket's Linear branch name (skipped when the agent decides)
2. Runs every later step inside that worktree, so Claude Code starts there and hooks see the right branch
3. Streams output to the run panel and saves the full log under the app's data folder

## How it gets Linear updates

Polling only (default every 60s, only the states shown on the board). No webhooks, no hosting.

## Not built yet

- Cloud runners (Claude Code cloud sessions, Managed Agents)
- Interactive terminals (runs are headless for now)
- Run windows and per-state run limits
