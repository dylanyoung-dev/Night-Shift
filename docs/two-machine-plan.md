# Plan: Night Shift on two machines (runner and viewer)

> **Superseded on 2026-11-18** by [remote-mode-plan.md](remote-mode-plan.md) (host and remote over Tailscale). Kept for reference only; this design will not be built.

Status: **triage (A) approved on 2026-11-18, with your decisions written in below.** Design (B to D) updated to match, awaiting your go-ahead. No code has changed.

**Decisions recorded on 2026-11-18:**

| Item | Decision |
|---|---|
| O1 | Reply rows, only while a run is waiting. |
| O2 | `steps.yml` is not read after the import, and not written. |
| O3 | One Linear team: IGN. |
| O4 | Shared base branch. Per runner may come later. |
| O5 | Start fresh: no old runs imported, local files left where they are. |
| O6 | The single run transcript is the complete output. |
| O7 | The Usage page on a viewer uses D1 totals. |
| O8 | Settings export and import stay, for local settings only. |
| O9 | Cleanup deletes output and keeps the run row. |
| O10 | Decide later. |
| C1 | The runner starts at Windows sign-in; it doesn't need to run signed out. |
| Cost | Workers Paid plan, in the existing AmplifyUp Cloudflare account. |
| Output cutoff | The D1/S3 cutoff is a setting. |
| New | Viewers can continue a finished run (B11). |

## How runs work today

Everything happens in one Electron main process on the machine where Night Shift is open.

1. **Start.** You press an action on a card, or an automation fires.
   - `Runner.start()` (`src/main/runner.ts`) adds a run to an in-memory queue.
   - At most `maxConcurrent` runs go at once (5 on this machine).
2. **Worktree.**
   - In `nightshift` mode, Night Shift fills `$REPO/.claude/worktrees/$ID` and the action's first step creates it (`git worktree add`).
   - In `agent` mode (this machine's setting) Night Shift creates nothing and the agent sets up its own.
   - Global actions get a fresh detached checkout of the base branch (`prepareBaseCheckout` in `src/main/git.ts`).
3. **Steps.**
   - Each step is `script`, `linear` or `claude`. `npm ci` is a script step with `only: nightshift`.
   - Scripts and Claude run with `spawn(command, { shell: true, windowsHide: true })` in the worktree or the repo.
   - `$TICKET $ID $BRANCH $BASE $WORKTREE $REPO` are filled in first and also set as `NS_*` environment variables.
4. **Claude.**
   - The command is `claude -p "/build $TICKET" --permission-mode auto --allowedTools mcp__claude_ai_Linear --output-format stream-json --verbose`.
   - The prompt goes in over stdin and stdin stays open, so you can reply while it runs.
   - `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` stops Claude cutting off background agents.
5. **Output capture.** There are three copies:
   - `runs/logs/<run>.log` is a readable log: script output in full, plus Claude's events formatted by `ClaudeStreamFormatter`. That formatter **trims** tool output to 40 lines and 400 characters a line.
   - `runs/logs/<run>.events.jsonl` holds Claude's raw stream-json events, untrimmed.
   - `logTail` keeps the last 20,000 characters in memory.
6. **Interactive parts:**
   - **Needs you:** a Claude turn ends with a question. You reply into the live session.
   - **Finish step:** ends the session so the run moves on.
   - **Continue a finished run:** `claude -p --resume <session>` with your reply, added as a "Reply" step.
7. **Linear.**
   - `linear` steps move the ticket.
   - After a run, the failure plan (`src/main/failure.ts`) labels it, comments and moves it back, or clears the label on success.
   - Since 0.1.3 the board also re-syncs a ticket when an agent writes to it.
8. **History.**
   - `runs/runs.json` keeps the newest 200 runs. It holds 127 today: 124 done, 1 failed, 1 stopped, and 1 waiting right now.
   - On start-up, runs left active are marked stopped.

> **Replies and continuing (decided):**
> - Viewers reply to a run that's **waiting** through `replies` rows (O1 = b).
> - Viewers can also **continue a finished run** (B11). It resumes the Claude session when it can, or starts a new agent with the earlier transcript as context.
> - Reply text is never stored in a request. A request only names a ticket, an action, and for a continuation the run and reply it belongs to.

---

## A. Triage of local data

These live in Night Shift's data folder, `%APPDATA%\night-shift\` (C:\Users\…\AppData\Roaming\night-shift), unless noted otherwise. Sizes are from this machine on 2026-11-18.

| # | What it is, and where it lives now | New home | Why | How existing data moves |
|---|---|---|---|---|
| 1 | **Actions** (step sets). Lives in the *agent repo*, `.nightshift/steps.yml`: 5 actions (Build steps, Planner, Review, Review fix, Global Audit). Note: that file is **not committed** in `auto-personalization-poc` today. | **D1**, versioned | They decide what the runner executes, so they must match everywhere. | A one-time import creates version 1 of each action. **Decided (O2):** after that Night Shift never reads or writes `steps.yml`. The file is left where it is, for you to delete. |
| 2 | **Automations**: `settings.json › automations` (none on this machine yet). | **D1**, versioned | Must be identical, and must fire once. | Imported from `settings.json` with each one switched off, so nothing fires during the move. |
| 3 | **Automation progress**: `automations.json` (last run, next run, runs done, "seen" tickets for watch mode). Doesn't exist here yet. | **D1** (`automation_state`) | Whoever evaluates automations must see the same progress, or a ticket runs twice. | None to move today. If it existed, it would be imported with the automations. |
| 4 | **Night Shift projects**: `settings.json › projects` (1 project: a name mapped to Linear project ids). | **D1** | Automations point at a project by id, so the runner must resolve it the same way. | Imported, keeping the same ids so automations still match. |
| 5 | **Linear team key**: `settings.json › linearTeamKey` (`IGN`). | **D1** (shared setting) | Action and automation state names belong to that team. | Imported. **Decided (O3):** one team, IGN. |
| 6 | **Base branch**: `settings.json › baseBranch` (`releases/nov-2026`). | **D1** (shared setting) | Global actions and new worktrees must start from the same branch on every runner. | Imported. **Decided (O4):** shared. A per-runner override can be added later as a local setting that wins over this one. |
| 7 | **Worktree mode**: `settings.json › worktreeMode` (`agent`). | **D1** (shared default; actions can still override) | It changes which steps run, so it's part of what an action does. | Imported. |
| 8 | **Worktree path template**: `settings.json › worktreePath`. | **Local** (runner) | A folder on that machine. | Stays. |
| 9 | **Repo path**: `settings.json › repoPath`. | **Local** (runner) | Rule: describes this machine. | Stays. The viewer doesn't need one. |
| 10 | **Concurrency limit**: `settings.json › maxConcurrent` (5). | **Local** (runner), copied into D1 on each heartbeat | Rule: per runner. Viewers see it via the `runners` row. | Stays. |
| 11 | **Linear API key**: `settings.json › linearApiKeyEnc`, encrypted with Windows DPAPI via Electron safeStorage. | **Local**, on every machine that needs it | The runner checks and updates tickets. The viewer still reads the board straight from Linear. It never goes to D1 or the Worker. | Stays. On the laptop you enter it again (or use a separate Linear key). |
| 12 | **Polling interval**: `settings.json › pollSeconds`. | **Local** | Only governs how often this machine checks Linear. Automation timing moves to the runner (see B5). | Stays. |
| 13 | **Board view**: `settings.json` `hiddenStateTypes`, `columnOrder`, `activeProjectId`, `theme`. | **Local** | Window and UI preferences. | Stays. |
| 14 | **Renderer UI state**: localStorage `nightshift.groupBy`, `nightshift.expandedLanes`, `nightshift.glimpseWidth`. | **Local** | UI preferences. | Stays. |
| 15 | **Run history**: `runs/runs.json` (127 runs, 660 KB). Status, steps with commands, Claude `sessionId`, cwd, branch, worktree. | **D1** (`runs`) | Rule: runs are shared. | **Decided (O5):** start fresh. Nothing is imported. `runs.json` stays on this machine untouched. Night Shift stops writing it once the machine uses the shared store. |
| 16 | **Run output**: `runs/logs/<run>.log` (127 files, 5.3 MB) and `<run>.events.jsonl` (124 files, 59.6 MB). | **D1 or S3** by size, for new runs | Shared and complete. | **Decided (O5):** not moved; the old files stay where they are. **Decided (O6):** new runs store one transcript (B8). |
| 17 | **Board cache**: `board-cache.json` (330 KB). | **Not stored** | Linear owns it; this is a per-machine 5-minute cache. | Stays as a local cache. |
| 18 | **Usage cache**: `usage-cache.json` (4.1 MB). Token totals parsed from `~/.claude/projects/**` transcripts on this machine. | **Local cache**; per-run totals go to **D1** | On the laptop, the Usage page would otherwise show only the laptop's own Claude use. | No move. New runs write tokens and cost to their `runs` row from Claude's `result` event. **Decided (O7):** the Usage page on a viewer is built from those D1 totals. |
| 19 | **Plan limits**: `limits.json` (the 5-hour and weekly percentages Claude reports). | **D1** (`runners.limits_json`, on each heartbeat) | Viewers want to see them, but they are what the runner's Claude account reported. | No move. The runner reports a fresh copy. |
| 20 | **App log**: `logs/main.log`. | **Local** | Diagnostics for that machine. | Stays. |
| 21 | **Update id**: `.updaterId` (electron-updater). | **Local** | Per install. | Stays. |
| 22 | **Chromium data**: `Cache/`, `GPUCache/`, `Local Storage/` and similar. | **Local** | Browser internals. | Stays. |
| 23 | **Exported settings file** (Settings › Export, YAML). | **Local**, reduced to local settings only | Shared parts now live in D1. | **Decided (O8):** export and import stay, covering local settings only: repo path, worktree path, concurrency limit, poll interval, board view and theme. Shared items (projects, automations, team, base branch) leave the file. |
| 24 | **Claude Code login and repo setup**: `~/.claude/`, the repo's `.claude/`, Git credentials. | **Local** (runner) | Not Night Shift's data. The runner uses whatever the runner's Windows user has. | No move. |
| 25 | **Ticket stats, relations, spec flag.** | **Not stored** | Computed from Linear and from runs. | None. |

**Approved on 2026-11-18.** Items 1 to 7 move in the one-time import (B10). Nothing else moves.

---

## B. Design

### B1. Shape

Every request arrow below goes through the Worker, behind Cloudflare Access.

```
 Viewer (laptop)          Cloudflare Access (service tokens checked here)        Runner (desktop)
 ─────────────            ───────────────────────────────────────────            ─────────────────
  create request ──HTTPS──▶  api.nightshift…  ──▶ Worker ──▶ D1                    claude -p …
  poll runs/output                          │      │    └──▶ S3 (signed, server-side)   ▲
                                            │      └──hook (no body)──▶ Access ──▶ Tunnel ──▶ 127.0.0.1:port
                                            └────── runner: claim / write / upload ◀──────────┘
```

- **Viewer:** any Night Shift with role `viewer`. It reads Linear directly for the board, and the Worker for actions, automations, runs and output. It never spawns a process.
- **Runner:** Night Shift with role `runner`, running headless (see C). It is the only thing that spawns `claude -p`. Each runner has its own token and a row in `runners`.
- **One machine can be both:** the desktop runs the headless runner, and its window is a viewer like the laptop.

### B2. D1 schema

Times are integer milliseconds. Ids are text, either UUIDs or the existing run-id format.

```sql
-- Shared settings that must match everywhere: team key, base branch, default worktree mode,
-- and output_d1_max_bytes (the D1/S3 cutoff; see B8).
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,            -- JSON
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT NOT NULL             -- token name
);

CREATE TABLE projects (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  linear_project_ids TEXT NOT NULL,     -- JSON array
  updated_at         INTEGER NOT NULL,
  deleted_at         INTEGER
);

-- Actions: a stable id, plus immutable versions. Editing makes a new version.
CREATE TABLE actions (
  id              TEXT PRIMARY KEY,
  current_version INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  deleted_at      INTEGER
);
CREATE TABLE action_versions (
  action_id   TEXT NOT NULL REFERENCES actions(id),
  version     INTEGER NOT NULL,
  name        TEXT NOT NULL,
  label       TEXT,
  is_global   INTEGER NOT NULL DEFAULT 0,
  states      TEXT NOT NULL,            -- JSON array of Linear state names
  worktree    TEXT,                     -- JSON {mode, path} or NULL
  steps       TEXT NOT NULL,            -- JSON array of {name,type,run,moveTo,cwd,onFail,only}
  on_failure  TEXT,                     -- JSON
  created_at  INTEGER NOT NULL,
  created_by  TEXT NOT NULL,
  PRIMARY KEY (action_id, version)
);

-- Automations: the same pattern. Switching one on or off is not a new version.
CREATE TABLE automations (
  id              TEXT PRIMARY KEY,
  current_version INTEGER NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  deleted_at      INTEGER
);
CREATE TABLE automation_versions (
  automation_id TEXT NOT NULL REFERENCES automations(id),
  version       INTEGER NOT NULL,
  definition    TEXT NOT NULL,          -- JSON: today's Automation fields (mode, states, action_id, days, window, …)
  created_at    INTEGER NOT NULL,
  created_by    TEXT NOT NULL,
  PRIMARY KEY (automation_id, version)
);
CREATE TABLE automation_state (
  automation_id   TEXT PRIMARY KEY REFERENCES automations(id),
  last_run_at     INTEGER,
  last_checked_at INTEGER,
  retry_at        INTEGER,
  runs_done       INTEGER NOT NULL DEFAULT 0,
  seen            TEXT NOT NULL DEFAULT '{}',  -- watch: issue id -> state name
  last_result     TEXT,
  lease_owner     TEXT,                  -- runner id evaluating it now
  lease_until     INTEGER
);

CREATE TABLE runners (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,       -- e.g. DESKTOP-DY
  access_client_id  TEXT NOT NULL UNIQUE, -- its Access service token's Client ID
  max_concurrent    INTEGER NOT NULL,
  app_version       TEXT,
  status            TEXT NOT NULL,       -- online | draining | offline | disabled
  last_heartbeat_at INTEGER,
  limits_json       TEXT,                -- Claude plan limits as last reported
  registered_at     INTEGER NOT NULL
);

-- Requests: what viewers (and automations) ask for. Never a prompt or a command.
CREATE TABLE requests (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,         -- ticket | global | continue
  linear_issue_id TEXT,                  -- NULL for global
  ticket          TEXT,                  -- IGN-644, for display
  action_id       TEXT NOT NULL REFERENCES actions(id),
  continues_run_id TEXT REFERENCES runs(id), -- continue only: the finished run to pick up
  reply_id        TEXT REFERENCES replies(id), -- continue only: the reply that asked for it (the text lives there)
  automation_id   TEXT REFERENCES automations(id),
  dedupe_key      TEXT,                  -- automations only, see B5
  requested_by    TEXT NOT NULL,         -- token name
  status          TEXT NOT NULL,         -- pending | claimed | started | rejected | canceled
  reject_reason   TEXT,
  claimed_by      TEXT REFERENCES runners(id),
  claimed_at      INTEGER,
  run_id          TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX requests_pending ON requests(status, created_at);
CREATE UNIQUE INDEX requests_automation_once ON requests(automation_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
-- At most one live request per ticket, so a double-click or two viewers can't queue it twice.
CREATE UNIQUE INDEX requests_one_live_per_ticket ON requests(linear_issue_id)
  WHERE status IN ('pending','claimed') AND linear_issue_id IS NOT NULL;

CREATE TABLE runs (
  id                  TEXT PRIMARY KEY,
  request_id          TEXT NOT NULL UNIQUE REFERENCES requests(id),
  runner_id           TEXT NOT NULL REFERENCES runners(id),
  linear_issue_id     TEXT,
  ticket              TEXT,
  title               TEXT,
  action_id           TEXT NOT NULL,
  action_version      INTEGER NOT NULL,
  automation_id       TEXT,
  continues_run_id    TEXT REFERENCES runs(id), -- set on a continuation (B11)
  continue_mode       TEXT,              -- resume | new_session (B11)
  status              TEXT NOT NULL,     -- running | waiting | done | failed | stopped | lost
  waiting_reason      TEXT,
  branch              TEXT,
  worktree_mode       TEXT,
  steps               TEXT NOT NULL,     -- JSON: per-step status, command, cwd, sessionId, times
  started_at          INTEGER NOT NULL,
  ended_at            INTEGER,
  cancel_requested_at INTEGER,
  cancel_requested_by TEXT,
  end_reason          TEXT,              -- e.g. "runner stopped responding"
  linear_followup     TEXT,              -- pending | done: failure plan still owed to Linear
  input_tokens        INTEGER, output_tokens INTEGER, cost_usd REAL,
  output_location     TEXT,              -- d1 | s3 | NULL while running
  output_text         TEXT,              -- when d1; bound parameter, ≤ 1.5 MB UTF-8
  output_s3_key       TEXT,              -- when s3: runs/<yyyy>/<mm>/<ticket>/<run-id>.log
  output_bytes        INTEGER,
  output_sha256       TEXT,
  updated_at          INTEGER NOT NULL
);
-- The hard rule: one live run per ticket, across every runner.
CREATE UNIQUE INDEX runs_one_live_per_ticket ON runs(linear_issue_id)
  WHERE status IN ('running','waiting') AND linear_issue_id IS NOT NULL;
CREATE INDEX runs_by_ticket  ON runs(linear_issue_id, started_at);
CREATE INDEX runs_by_runner  ON runs(runner_id, status);
CREATE INDEX runs_changed    ON runs(updated_at);   -- viewers poll "what changed since"

-- What you type to an agent from a viewer (O1 = b, and B11).
CREATE TABLE replies (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES runs(id), -- the run replied to
  purpose    TEXT NOT NULL,              -- waiting (into the live session) | continue (starts B11)
  text       TEXT NOT NULL,              -- up to 20,000 characters
  sent_by    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  taken_at   INTEGER                     -- set when the runner passes it to Claude
);
CREATE INDEX replies_untaken ON replies(run_id) WHERE taken_at IS NULL;
```

List queries name their columns, so `output_text` is only read by the output route.

### B3. Worker API and who can call it

**Who can reach what (two layers):**
- **Paths, at Cloudflare:** Access applications are set per path on `api.<host>`, and each application's policy allows only certain service tokens. That way the role is enforced before the request reaches the Worker:
  - `/v1/runner/*` allows runner tokens;
  - `/v1/admin/*` allows admin tokens;
  - everything else under `/v1/*` allows viewer, admin and runner tokens.
- **In the Worker, as a second layer:**
  - It checks the signed `Cf-Access-Jwt-Assertion` header against your team's Access keys.
  - It maps the token's Client ID (the JWT's `common_name`) to a role and name from Worker config.
  - Its `workers.dev` address and preview URLs are switched off in `wrangler.toml`, so there's no way round Access.
- Cloudflare's docs confirm Access can protect a Worker on a custom domain.
- **Not verified:** that path-scoped Access applications, one per path on the same hostname, pick the most specific path. That's what makes the per-role paths work. The runbook tests it (step 3.6).

**Viewer, admin and runner tokens (read-only):**

| Route | Does |
|---|---|
| `GET /v1/changes?since=` | Runs, requests, runners, actions and automations changed since a cursor. This is what viewers poll, and it keeps reads small. |
| `GET /v1/actions`, `/v1/automations`, `/v1/projects`, `/v1/settings`, `/v1/runners` | Current versions and status. |
| `GET /v1/runs?ticket=&status=&before=&limit=` and `GET /v1/runs/:id` | Run rows, without output. |
| `GET /v1/runs/:id/output` | The full output. From D1 it's returned directly; from S3 the Worker fetches it with SigV4 and streams it back. Same response either way. |

**Viewer and admin tokens (actions):**

| Route | Does |
|---|---|
| `POST /v1/requests` `{linear_issue_id, action_id}` or `{action_id}` for global | Creates a request, then calls the hook. |
| `POST /v1/requests/:id/cancel` | A pending request is canceled straight away. |
| `POST /v1/runs/:id/cancel` | Sets `cancel_requested_at`, then calls the hook. |
| `POST /v1/runs/:id/replies` `{text}` | Only while the run is `waiting`. Saves the reply and calls the hook, so the runner passes it to Claude within seconds. |
| `POST /v1/runs/:id/continue` `{text}` | Only on a finished run (`done`, `failed`, `stopped` or `lost`). Saves a `continue` reply and a `continue` request (B11), then calls the hook. |

**Admin token only:**

| Route | Does |
|---|---|
| `PUT /v1/admin/actions/:id`, `DELETE …` | Saves a new version, or marks deleted. |
| `PUT /v1/admin/automations/:id`, `POST …/enable`, `POST …/disable` | |
| `PUT /v1/admin/projects/:id`, `PUT /v1/admin/settings/:key` | Includes `output_d1_max_bytes` (B8). |
| `POST /v1/admin/cleanup/preview` `{older_than_days}` | Returns the count, total bytes, and how many are in D1 vs S3. |
| `POST /v1/admin/cleanup` `{older_than_days, expect_count}` | Deletes S3 objects and clears output. It refuses if the count changed since the preview. |
| `POST /v1/admin/import` | The one-time migration of B10. |

**Runner tokens only:**

| Route | Does |
|---|---|
| `POST /v1/runner/heartbeat` `{max_concurrent, active_run_ids, limits, app_version}` | Registers on first call, matched by Client ID. Returns runs to cancel and pending replies. |
| `POST /v1/runner/claim` `{free_slots}` | Claims up to `free_slots` requests (B4) and returns each with the exact action version snapshot. |
| `POST /v1/runner/requests/:id/reject` `{reason}` | For example, the ticket isn't in a state that allows the action. |
| `POST /v1/runner/runs` | Creates the run row from a claimed request. |
| `PATCH /v1/runner/runs/:id` | Status, steps and waiting reason, at step boundaries. |
| `PUT /v1/runner/runs/:id/output` | Body ≤ the cutoff (`output_d1_max_bytes`): stored in `output_text` as a bound parameter. A larger body is refused with 413, and the runner uses the S3 route instead. |
| `GET /v1/runner/runs/:id/output` | The earlier run's transcript, for a continuation in a new session (B11). |
| `POST /v1/runner/runs/:id/output-url` | Returns a presigned S3 PUT for the fixed key, valid 10 minutes. |
| `POST /v1/runner/runs/:id/output-done` `{bytes, sha256}` | The Worker checks the object's size in S3, then sets `output_location='s3'`. |
| `POST /v1/runner/automations/lease` and `…/fire` | See B5. |

**Worker to runner:** `POST https://hook.<host>/check` with an empty body, carrying the Worker's own hook token. The runner answers 204 straight away and then calls `heartbeat` and `claim`.

**B3a. Who edits actions and automations: a separate admin token (recommended).**
- An action's steps are shell commands that run as you on the runner. Editing an action is effectively running code on your desktop.
- So a viewer token, the one on a laptop that could be lost, can start known actions but can't change what they do.
- Hold the admin token on the desktop's viewer. If you want to edit from the laptop too, keep it there in Windows Credential Manager.
- The same logic applies to your Cloudflare account: anyone who can edit D1 in the dashboard can change actions. Make sure the account has 2FA.

### B4. Claiming, so two runners can never take the same ticket

- The Worker claims one request at a time with one conditional statement. D1 runs writes one after another on a single primary, so two claims can't interleave:

```sql
UPDATE requests SET status='claimed', claimed_by=?1, claimed_at=?2
WHERE id = (
  SELECT r.id FROM requests r
  WHERE r.status='pending'
    AND NOT EXISTS (SELECT 1 FROM runs x WHERE x.linear_issue_id=r.linear_issue_id AND x.status IN ('running','waiting'))
  ORDER BY r.created_at LIMIT 1)
AND status='pending'
RETURNING *;
```

- It repeats that up to `free_slots` times.
- **Continue requests (B11)** add one condition: while the original runner is online, or for the first 2 minutes, only that runner may claim them.
- **The guarantee doesn't rest on the claim alone.** The partial unique index `runs_one_live_per_ticket` rejects a second live run for the same ticket, even if a bug let two claims through. If `POST /v1/runner/runs` fails on that index, the runner releases the request.
- **Global actions:** one live run per action, enforced by a similar index keyed on `action_id` for global runs.
- **Before starting**, the runner fetches the ticket from Linear:
  - it must still exist;
  - its state must be one of that action version's `states`.
  - If not, it calls `reject`. Nothing runs, and the request shows "rejected: ticket is in Done".
- **OPEN:** I haven't confirmed in D1's documentation that `UPDATE … RETURNING` and partial indexes behave as in SQLite. See *Not verified*.

### B5. Automations fire exactly once: runners evaluate them, viewers never do

- **Who evaluates.** Automations need Linear (to find tickets), and runners already have a Linear key. Viewers never evaluate, so having Night Shift open on more machines changes nothing.
- **Two runners.** Each automation has a lease in `automation_state`. A runner takes it with a conditional `UPDATE … WHERE lease_until < now RETURNING` and holds it about 2 minutes while it checks Linear.
- **One atomic write.** The firing happens in one D1 batch: insert the requests, and update `runs_done`, `seen`, `last_run_at` and the lease.
- **Backstop for duplicates.** Every automation request carries a `dedupe_key`:
  - **schedule:** the time slot it fired for;
  - **watch:** `issue_id:state:arrival_n`, where `arrival_n` counts how many times the ticket has entered the state, kept in `seen`.
  - The unique index `requests_automation_once` rejects a duplicate even if two evaluators ever overlap.
- **Rejected alternative: the Worker evaluates them on a cron.** That would need a Linear key stored as a Worker secret, and it would put the Linear calls inside Cloudflare's per-request limits. If you'd rather the cloud own timing, say so.

### B6. Concurrency per runner, and a queue

- Each runner reads `maxConcurrent` from its local settings and only claims while running < max.
- Extra requests wait as `pending` in D1. Viewers see them as "queued", with their position by `created_at`.
- More runners add more capacity with no changes: each claims what it has room for.

### B7. Cancel and dead runs

- **Cancel.**
  - A viewer sets `cancel_requested_at`, and the Worker calls the hook.
  - On its next heartbeat the runner gets the run id back, kills the process tree (`taskkill /T /F`, as today), marks the run `stopped` and applies the action's failure plan to Linear.
  - A request that hasn't been claimed yet is just canceled.
- **Runner heartbeat.**
  - Every 30 seconds, plus the hook and a check every 5 minutes.
  - The heartbeat updates only the `runners` row, not each run, to keep D1 writes low. It sends the ids of the runs the runner really has going.
- **Dead runs.**
  - A Worker cron runs every 5 minutes. A live run becomes `lost` (shown as failed), with `end_reason = "runner stopped responding"` and `linear_followup = 'pending'`, in either case:
    - its runner's `last_heartbeat_at` is older than 3 minutes;
    - its id was missing from that runner's latest heartbeat list.
  - **On start-up**, a runner marks its own runs that are still live in D1 as `failed` ("runner restarted"), as `loadHistory` does locally today.
  - **Linear follow-up.** Any runner checks for `linear_followup = 'pending'` runs and applies their failure plan to Linear, then sets it to `done`. The Worker never holds a Linear key.

### B8. Output: the run transcript (decided, O6)

What is stored today:
- The **readable log** is complete for scripts but **trims Claude's tool output**.
- The **raw events** are complete for Claude but don't include script output such as `npm ci`.
- **Neither file alone is the complete, untruncated output.**

Decided: the runner writes one **run transcript** file as the run goes, one line per chunk in order:
- every script output chunk;
- every raw Claude event;
- Night Shift's own notes ("▸ Build", "Run done.").

At the end it is stored as **one** object, D1 or S3 by size, never split. The viewer rebuilds today's readable log view from it, so the readable log no longer needs storing separately.

**Measured on the 127 existing runs:**

| If "output" means… | Median | 90th percentile | Largest | Over 1.5 MB → S3 |
|---|---|---|---|---|
| readable `.log` only | 22 KB | 99 KB | 342 KB | **0 of 127** |
| raw events only | 289 KB | 1,125 KB | 3,851 KB | **5 of 124** |
| log + events (≈ the transcript) | 304 KB | 1,220 KB | 4,193 KB | **6 of 127 (≈ 5%)** |

So with the transcript, about 1 run in 20 would go to S3 at a 1.5 MB cutoff.

**The cutoff is a setting.**
- It's the shared setting `output_d1_max_bytes`, default **1,572,864** (1.5 MB in UTF-8 bytes).
- Admin token only, on Settings › Shared store.
- Allowed range: 0 (everything to S3) to **1,900,000**. D1 caps a row at 2,000,000 bytes, and the rest of the run row needs room.
- The **Worker** applies it, not the runner. When the runner finishes, it asks the Worker where the output goes, so every runner follows the current value.
- Lowering it later only affects new runs. Existing outputs stay where they are.

**Cleanup.** A manual "Clean up old runs" action, as decision 13 asks:
- choose an age, see the count and size, confirm;
- the Worker deletes the S3 objects and clears `output_text`;
- run rows stay, marked `output_location = 'deleted'` (decided, O9).
- A run whose output was cleaned up can't be continued in a new session (B11), because there is no transcript to give the new agent. It can still be resumed if its Claude session exists on the runner.

### B9. Usage and cost

See [Usage and cost](#usage-and-cost) at the end.

### B10. Migration of existing data (approved scope)

1. Import the actions from `steps.yml`, each as version 1. Night Shift then stops reading and writing that file (O2).
2. Import projects, the shared settings (team IGN, base branch, worktree mode, and the output cutoff at its default) and automations, with automations switched off.
3. **No runs** (O5). The local `runs/` folder, `runs.json` and logs stay as they are. Once a machine is connected to the shared store, Night Shift shows runs from D1 only. The old local history is no longer shown in the app, though the files are still on disk.

All of this is done by a Night Shift command, "Copy this machine's data to the shared store", which calls `POST /v1/admin/import`. It is idempotent by id, so running it twice does nothing extra.

### B11. Continuing a finished run from a viewer

Today the app continues a finished run by resuming its Claude session (`claude -p --resume <session>`) on the same machine. With several machines, the session may not be there, so a continuation has two modes.

1. **Asking.** On a finished run, a viewer types a message and chooses **Continue**. The Worker saves:
   - a `replies` row (`purpose = continue`), holding the text;
   - a `continue` request naming the earlier run, that reply and the same action.

   No prompt is stored in the request.
2. **Which runner.**
   - **First choice: the runner that did the original run.** The Claude session lives in that machine's `~/.claude`, and so does the worktree.
   - Only that runner may claim the request for its first **2 minutes**, or while it's online.
   - After that, if it's offline, any runner may claim it.
3. **Checks before starting.**
   - The ticket must still exist and be **open**: not completed or canceled.
   - Unlike a normal request, it doesn't have to be in the action's states. Continuing usually happens after the agent has moved the ticket, for example into review.
   - The one-live-run-per-ticket rule still applies.
4. **Mode A, resume (preferred).** Used when this runner ran the original, the run has a Claude `sessionId` and its folder (`cwd`) still exists.
   - The runner runs `claude -p --resume <session>` with the original step's flags, and passes the reply over stdin (as today).
   - The new run row records `continue_mode = 'resume'`.
5. **Mode B, new session (fallback).** Used when resume isn't possible: another runner, the session or folder is gone, or `claude --resume` fails at once.
   - The runner fetches the earlier run's full transcript (`GET /v1/runner/runs/:id/output`) and writes two files:
     - `previous-run.txt`, a readable rendering made the same way as the log view;
     - `previous-run.jsonl`, the full transcript.
   - Both go in a folder for the new run under the worktree, or the repo when the agent sets up the worktree, inside `.claude/nightshift/<run-id>/`.
   - It starts a new `claude -p` with **the same flags as the action's Claude step** and this prompt:
     > Continue the work from an earlier Night Shift run on $TICKET. Its transcript is in `previous-run.txt` (full raw events in `previous-run.jsonl`); read it first. Then do what the person asks: <reply text>
   - The new run row records `continue_mode = 'new_session'`.
   - If the earlier output was cleaned up (O9), mode B isn't possible. The request is rejected with "the earlier run's output was deleted".
6. **The result is a new run, not an addition to the old one.**
   - Its row has `continues_run_id`, its own transcript, its own status and its own Linear follow-up.
   - The viewer shows it under the earlier run as a thread.
   - Today's local app instead adds a "Reply" step to the same run. That doesn't fit stored, finished output, which must never change.
7. **Where it runs.** It runs in the earlier run's worktree if that exists on this runner. Otherwise:
   - in **agent** worktree mode (your setting), it runs in the repo and the agent sets up its own worktree on the ticket's branch;
   - in **nightshift** mode, the runner first recreates the worktree on the ticket's branch (`git worktree add $WORKTREE $BRANCH`, without `-b`) and runs there.
8. **Replies to a waiting run are different (O1).**
   - They go into the live session. The runner gets them on its next heartbeat, or at once through the hook.
   - They're logged into the transcript as `▶ You: …` notes, so the transcript stays complete.

---

## C. Runner on Windows

### C1. Decided: start the headless runner when you sign in to Windows

The desktop is always signed in, so the runner doesn't need to work while you're signed out (decided 2026-11-18).

**The setup:**
- `Night Shift.exe --runner` starts Night Shift's main process with no window and no tray icon.
- It starts **at sign-in**, as a Task Scheduler task with these settings:
  - trigger **At log on** of your user;
  - **"Run only when user is logged on"**, so no stored password;
  - restart on failure every minute;
  - no time limit.
- It runs in your own session, with everything an interactive Night Shift has:
  - your Claude Code login in `~/.claude`;
  - the repo's `.claude/` setup;
  - Git Credential Manager;
  - Electron `safeStorage` (DPAPI), for Night Shift's encrypted keys.
- The normal Night Shift window on the desktop is a viewer, separate from the runner process. Closing it doesn't stop the runner.
- **Why a task and not the Startup folder or a registry Run key:** a task can restart the runner if it crashes, and can be switched off with one command (`Disable-ScheduledTask`) in an emergency.

**Still to check (runbook step 5):**
- **Sleep.** The machine must not sleep, so set sleep to Never on AC power.
- **One runner process.** If you open Night Shift while the runner is going, it must open a window as a viewer and not start a second runner. The single-instance lock covers runner mode separately.
- **Updates.** Auto-update restarts the runner only when it has no active runs.

**If a future runner must work while signed out**, three things change:
1. The task uses **"Run whether user is logged on or not"** with that Windows user's password stored by Task Scheduler. Or it becomes a service under that user, using a wrapper such as WinSW.
2. Accounts that sign in only with Windows Hello or a PIN, typical for Entra ID, may not be able to store a password for this. A server would use a local or dedicated account.
3. Untested in that mode, so verify first:
   - Claude Code's claude.ai login (fallback: `claude setup-token` and `CLAUDE_CODE_OAUTH_TOKEN`, stored carefully);
   - Git credentials;
   - DPAPI decryption.

### C2. Where tokens live

| Machine | Secret | Where |
|---|---|---|
| Runner | Access service token for the API (runner role), and its Linear key | `settings.json`, encrypted with DPAPI via safeStorage. Same mechanism as the Linear key today, readable only by your Windows user. |
| Runner | Cloudflare Tunnel token | Installed with `cloudflared service install <token>`. cloudflared keeps it in its own service config; Night Shift never sees it. |
| Viewer (laptop) | Access service token (viewer role, or admin if you choose), and its own Linear key | `settings.json` on the laptop, encrypted with DPAPI. |
| Worker | AWS access key and secret, the Access token for calling the hook, and your Access team domain and audience tags | Worker secrets (`wrangler secret put`). Never in the repo. |
| Your machine | Wrangler login for deploying | `wrangler login` (browser OAuth), or a scoped API token in the git-ignored `.env`. |

---

## Usage and cost

Prices and limits were checked on 2026-11-18 against Cloudflare's docs and AWS's price list.

| Source | Updated |
|---|---|
| [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) | 2026-11-18 |
| [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) | 2026-10-30 |
| [Tunnel](https://developers.cloudflare.com/tunnel/), [Zero Trust account limits](https://developers.cloudflare.com/cloudflare-one/account-limits/) | 2026-11-17/18 |
| [Access plans](https://www.cloudflare.com/sase/products/access/) | not dated |
| [S3 pricing](https://aws.amazon.com/s3/pricing/) | AWS Price List API files dated 2026-11-17/18. The S3 page itself renders its tables with JavaScript. |

### Assumptions

- **Run volume.**
  - **3 agents:** about 35 runs a day. Your actual history is 11 to 41 a day over the last 5 days.
  - **30 agents:** about 350 runs a day, on 5 runners.
- **Output, from the 127 real runs, using the recommended transcript:**
  - 95% stay in D1, averaging 430 KB;
  - 5% go to S3, averaging 2.34 MB.
- **Per run:** about 13 Worker calls and 13 D1 row writes (request, claim, run, step updates, output).
- **Runners:** a heartbeat every 30 seconds each.
- **Viewers:** each open and focused 8 hours a day, polling `/v1/changes` every 10 seconds. That's about 10 rows read per poll, using the `updated_at` index.
- **Automations:** one lease attempt a minute per runner.
- **Index writes:** D1 counts extra row writes when indexed columns change. I've multiplied writes by 2.5 for that, as an estimate.

### Daily volume

| Per day | 3 agents (1 runner, 1 viewer) | 30 agents (5 runners, 3 viewers) | Free allowance | Paid ($5/mo Workers plan) |
|---|---|---|---|---|
| Worker requests | ≈ 8,000 | ≈ 35,000 (≈ 1.05 M a month) | 100,000 a day | 10 M a month included |
| Worker CPU | small | ≈ 5 M ms a month at about 5 ms a request | **10 ms per request cap** | 30 M ms a month included |
| D1 rows written | ≈ 12,000 | ≈ 50,000 | 100,000 a day | 50 M a month included |
| D1 rows read | ≈ 50,000 | ≈ 250,000 | 5 M a day | 25 B a month included |
| **D1 storage added** | **≈ 14 MB** (≈ 430 MB a month) | **≈ 143 MB** (≈ 4.3 GB a month) | **500 MB per database** | 10 GB per database; 5 GB included, then $0.75/GB-month |
| S3 data added | ≈ 4 MB (≈ 115 MB a month) | ≈ 38 MB (≈ 1.15 GB a month) | (no free tier assumed) | $0.023/GB-month, PUT $0.005 per 1,000, GET $0.0004 per 1,000 |

### Verdict

Decided: Workers Paid, in your existing AmplifyUp Cloudflare account. If that account already pays for Workers, there's nothing extra to buy, and the $5 is shared with anything else running there. The allowances in the table are per account, so other AmplifyUp Workers count against them too.


- **Requests and rows** stay inside the Free allowance even at 30 agents.
- **Storage doesn't.** Output stored in D1 fills the Free plan's **500 MB database limit in about 5 weeks at 3 agents**. You need the **$5/month Workers Paid plan** from the start. It also removes the 10 ms CPU cap, which the JWT check plus large output responses could hit.
- **On Paid:**
  - **3 agents:** expect **$5/month**. Storage passes the included 5 GB after about a year, then adds about $0.30/month per extra 400 MB month.
  - **30 agents:** expect **about $5 to $8/month**. One D1 database reaches its **10 GB cap in about 2½ months**. Running "Clean up old runs" to keep about 60 days holds it near 8.5 GB, about $2.60/month over the included 5 GB.
- **S3:** cents a month at either size.
  - 3 agents: about 1.4 GB after a year, under $0.05/month.
  - 30 agents: about 14 GB after a year, about $0.32/month.
  - Requests are negligible.
  - Output read back through the Worker counts as internet egress. That falls inside AWS's 100 GB/month free egress at these sizes.
- **Tunnel:** free (1,000 tunnels per account).
- **Access:** free plan, 50 users. **50 service tokens per account**: one hook token, one admin token, and one per runner and per viewer, so plenty of room.

**O10 (growth), deferred by you:** at 30 agents the 10 GB per-database cap makes cleanup a monthly chore. Without redesign, either:
- **(a) A separate outputs database.** Move `output_text` to its own D1 database (`runs_output`), and start a new one per year if needed. Runs stay in the main database.
- **(b) A lower threshold.** Lower the 1.5 MB threshold so more output goes to S3. At 30 agents, 256 KB would send most of it to S3 for about $1 a year.

Recommendation when you decide: (a). Option (b) is now just the cutoff setting (B8).

## Not verified

- **D1 behaviour.**
  - **`UPDATE … RETURNING`** for the claim. D1 runs SQLite, but its docs don't mention `RETURNING`. Fallback: claim with a `batch()` (an update, then a select on `claimed_by` and `claimed_at`). D1 documents batches as transactions.
  - **Partial unique indexes** (`CREATE UNIQUE INDEX … WHERE …`). Standard SQLite, but not shown in D1's docs.
  - **Index writes billing.** How exactly D1 counts row writes for index updates. I used ×2.5.
- **Cloudflare Access.**
  - **Path-scoped applications** on one hostname, choosing the most specific path.
  - **Service tokens on the Zero Trust Free plan.** The account limits list 50 tokens with no plan note.
  - **Duration options.** Whether a service token can be made non-expiring. The runbook uses 1 year and a reminder to rotate.
  - **Worker sending service-token headers.** The docs show this with curl; a Worker example was only seen in search snippets.
- **Windows runner.**
  - The runner runs in your signed-in session (C1), so Claude Code's login, Git and DPAPI behave as they do today. Only the signed-out case in C1 is untested.
  - Resuming a Claude session (B11 mode A) from the headless runner exactly as the window does today. It uses the same code path, but hasn't been tested in runner mode.
- **Install path.** Where the installer puts Night Shift (`%LOCALAPPDATA%\Programs\…`). It isn't installed on this desktop; you run it from source here.
- **The `amplifyup.ai` zone.** That it's a Cloudflare zone in the same account as `dylanyoung.dev`. A Tunnel hostname and a Worker custom domain both need that.
