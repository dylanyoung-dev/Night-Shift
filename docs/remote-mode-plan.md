# Plan: host and remote over Tailscale

Status: **approved on 2026-11-18, with the additions in section 8. Build step 1 is done; waiting for your laptop test (section 7, step 0).** This replaces the Cloudflare design in [two-machine-plan.md](two-machine-plan.md), which is kept for reference only. Items marked **OPEN** are unverified or need a decision.

## The idea in one paragraph

**The host** is the desktop.
- It runs Night Shift as today: same agents, same files, same data. Nothing is migrated.
- It also serves an HTTP API on its Tailscale address only.

**A remote** is the laptop.
- It runs Night Shift in remote mode.
- It reads the board straight from Linear with its own key, and everything else from the host.
- Every action executes on the host: starting, stopping, replying, continuing and editing actions or automations.
- It never runs an agent and stores no run data.

## 1. The host definition

One block in the host's `settings.json`, shown as **Settings › This machine is the host**:

```json
"host": {
  "enabled": true,
  "name": "dylandesktop",          // shown to remotes; defaults to the Tailscale machine name
  "port": 47615,                   // editable in Settings
  "allowedLogins": [],             // empty = only the Tailscale user this host is signed in as
  "apiVersion": 1                  // set by the app, not edited
}
```

The address isn't stored, because Tailscale owns it.
- At start, and every minute after, the host asks Tailscale for its own addresses (`tailscale ip -4` and `-6`) and binds to exactly those. If Tailscale isn't up yet, it waits and retries every 15 seconds.
- Settings shows the result as the connect details a remote needs: name, MagicDNS name, Tailscale IPs and port.
- A **Copy connection** button copies `dylandesktop.tail1a8202.ts.net:47615` for pasting into the remote.

On a remote, `settings.json` gets the matching block:

```json
"remote": { "host": "dylandesktop.tail1a8202.ts.net", "port": 47615 }
```

The mode is `standalone` (today's behaviour), `host` or `remote`.

## 2. API routes

The routes mirror the app's existing internal calls: the renderer's 35 calls to the main process plus its 8 live updates. Every route is JSON, under `/v1`.

**Host and live updates**

| Route | Does |
|---|---|
| `GET /host` | Name, app version, `apiVersion`, time. Remotes use it to check they're compatible. |
| `GET /events` | Server-sent events: `runs`, `run-output` (live log chunks), `automations` status, `settings` / `actions` / `projects` changed, `limits`, `tickets-changed` (so the remote re-syncs those tickets from Linear). |

**Shared settings**

Each item carries a `rev`. Every write must send `If-Match: <rev>` (see section 3).

| Route | Does |
|---|---|
| `GET /shared` | Shared settings, projects, and the host's machine settings (read-only to remotes). |
| `PUT /shared/settings/:key` | One shared setting. |
| `PUT /projects/:id`, `DELETE /projects/:id` | |
| `GET /actions` | All actions, from the host's `steps.yml` as today, each with its `rev`, plus any problems in the file. |
| `PUT /actions/:name`, `POST /actions`, `DELETE /actions/:name` | The host rewrites `steps.yml` with only that action changed. |
| `GET /automations` | Definitions and status. |
| `PUT /automations/:id`, `DELETE /automations/:id`, `POST /automations/:id/run-now` | |

**Runs**

| Route | Does |
|---|---|
| `GET /runs`, `GET /runs/:id` | History and status, as the host keeps it in `runs.json`. |
| `GET /runs/:id/log` | The full readable log file. |
| `GET /runs/:id/events` | The full raw Claude events file (`.events.jsonl`), untrimmed. |
| `POST /runs` `{issueId, action}` | The host fetches the ticket from Linear with its own key, checks its state allows the action, then starts it. |
| `POST /runs/global` `{action}` | Starts a global action. |
| `POST /runs/:id/stop` | |
| `POST /runs/:id/reply` `{text}` | Into a run that's waiting, as today. |
| `POST /runs/:id/finish-step` | |
| `POST /runs/:id/continue` `{text}` | Continue a finished run, as today: it resumes the Claude session. **Decided (R1): no fallback.** If the session is gone, the host refuses with 409 and "This run's Claude session no longer exists on dylandesktop, so it can't be continued. Start the action again instead." The same message shows on the remote and in the host's window, and is written to the host's log. |

**Usage and limits:** `GET /usage?days=`, `GET /ticket-stats?days=`, `GET /limits`, `POST /limits/check`. These come from the host, where the agents' Claude transcripts are.

**Stay local on the remote, never sent to the host:**
- the board and all Linear reads and edits (statuses, labels, the detail panel, relations, images);
- opening links;
- theme and board view;
- local settings export and import;
- file pickers.

## 3. Editing from two places without overwriting

- **Each item has a revision.**
  - Actions, automations, projects and each shared setting have a `rev`: a short hash of that item's current content as the host has it.
  - For actions, that's what's in `steps.yml` right now, so hand edits and `git pull` are noticed too.
- **Every save sends the `rev` it started from.** The host's own window does the same, so there is no special case for it.
- **Save only when unchanged.** The host saves only if the item's current `rev` still matches. Otherwise it answers **409 Conflict** with the current version and who saved it (the machine name).
- **What you see on a conflict:** "Changed on DylanLaptop at 10:42 while you were editing. Your change wasn't saved." Then two buttons:
  - **Load their version**, which drops yours;
  - **Copy mine and load theirs**, which keeps your edit on screen so you can reapply it.
- **Never overwritten silently.** Editing two *different* actions at once doesn't conflict, because the host rewrites only the action being saved.
- **Changes appear everywhere at once.** After any save the host sends a `settings`/`actions` event, so every open machine reloads that item straight away.

## 4. Shared and per-machine settings

| Setting | Where it lives | Who can change it |
|---|---|---|
| Actions (`steps.yml` in the host's repo) | Host | Host or any remote |
| Automations and their progress | Host | Host or any remote. Only the host evaluates them. |
| Projects | Host | Host or any remote |
| Linear team key, base branch, default worktree mode | Host | Host or any remote |
| Automation check interval (`pollSeconds`) | Host | Host or any remote. It only sets how often the host checks automations. |
| Board refresh interval (how often this machine reloads the board from Linear; today a fixed 5 minutes) | Each machine | That machine. New setting, default 5 minutes. |
| Repo path, worktree path, concurrency limit | Host | Host only. Remotes see them read-only. |
| Host definition (name, port, allowed logins) | Host | Host only |
| Runs, logs, full output, plan limits, usage cache | Host | Written by the host only |
| Linear API key | Each machine | That machine |
| Board view: hidden state types, column order, active project, group by, open lanes, panel width | Each machine | That machine |
| Theme | Each machine | That machine |
| Mode and remote target (`remote.host`, `remote.port`) | Each remote | That machine |
| Board cache, app log, update id | Each machine | That machine (caches) |

Settings › Export and Import keep working for each machine's own settings.

## 5. How remote mode changes the app

**Where the change is made**
- The window's bridge to the main process is unchanged.
- In remote mode, the main process forwards host-owned calls to the host over HTTP, and turns `GET /events` back into the same live updates the window gets today.
- Board and Linear calls stay local.
- So the screens barely change.

**What's different on screen**
- A **Remote · dylandesktop** chip in the top bar, green when connected.
- Settings splits into **This machine**, **Shared** (editable) and **Host machine** (read-only).
- The local runner and automations are switched off: the remote has no runner object at all, so it can't spawn an agent.
- "Needs you" notifications still pop up on the remote, from the live updates.

**The board on a remote**
- It refreshes from Linear on that machine's own **board refresh interval** (Settings › Linear, default 5 minutes), plus the refresh button.
- It also re-syncs single tickets when the host reports that an agent changed them.
- The shared `pollSeconds` doesn't affect it; that only drives automations on the host.

**When the host is off or unreachable**
- **The board still works:** it comes from Linear with the remote's own key, and ticket edits still work.
- **Runs, actions, automations and shared settings** show a banner, "Can't reach dylandesktop since 10:42. Retrying…".
- **During this session:** whatever arrived earlier stays visible, greyed and read-only. It's held in memory only, never written to disk.
- **After a restart while the host is off:** those screens are empty, with the same banner.
- **Start, stop, reply, continue and every save are disabled,** with "Host offline" on hover.
- **Reconnecting:** the remote retries every 10 seconds and catches up as soon as the host answers.
- **Version mismatch:** if the host's `apiVersion` doesn't match, the banner says which machine to update, and only reading is allowed.

**On the host**
- **At Windows sign-in** it starts with no window: a sign-in task with `--headless`, as decided in C1.
- **Opening Night Shift** while it runs opens a window in that same process. A second copy is never started, using Electron's single-instance lock.
- **Closing the window** leaves the host running.

## 6. Bound to Tailscale only, and checking who's calling

**Binding**
- The server listens on the host's Tailscale addresses only, IPv4 `100.x.y.z` and IPv6 `fd7a:…`, never `0.0.0.0`, `::` or `localhost`.
- If Tailscale has no address, the server doesn't start, rather than falling back to another interface.
- Plain HTTP is used inside the tailnet. Tailscale encrypts traffic between devices end to end with WireGuard.

**Checking the caller**
- For each connection the host runs `tailscale whois --json <caller ip:port>`, cached per caller IP for 5 minutes. That returns the Tailscale user and device.
- The request is allowed only if the user's login is in `allowedLogins`, or, when that's empty, equals the host's own Tailscale login.
- Tagged or shared-in devices have a different or no user, so they are refused with 403.
- If `whois` fails, the request is refused, so the check fails closed.

**What I verified on this desktop (2026-11-18)**

The setup: Tailscale 1.104.5, address `100.88.252.16`, MagicDNS name `dylandesktop.tail1a8202.ts.net`. A test server (`node:http`) was bound to `100.88.252.16:47615`.

| Check | Result |
|---|---|
| Listening sockets (`Get-NetTCPConnection -LocalPort 47615 -State Listen`) | **Only** `100.88.252.16:47615` |
| Request to `100.88.252.16:47615` | Answered |
| Request to the Wi-Fi address `192.168.68.200:47615` | No connection (timed out) |
| Request to the WSL adapter `172.31.208.1:47615` | No connection (timed out) |
| Request to `127.0.0.1:47615` | Refused |
| `tailscale whois` on the caller, run as your normal (non-admin) user | Returned the device (`dylandesktop`) and your Tailscale login |

**Build step 1, tested on this desktop (2026-11-18).** The real `HostServer` code was run against Tailscale on port 47616:

| Check | Result |
|---|---|
| Listening sockets | Only `100.88.252.16` and `fd7a:115c:a1e0::9b01:fcde` |
| `GET /v1/host` on both Tailscale addresses | 200, with `caller.device` = `dylandesktop` |
| Wi-Fi (`192.168.68.200`, `fe80::…`), WSL (`172.31.208.1`, `fe80::…`), `127.0.0.1` and `::1` | Connection refused |
| A route that doesn't exist | 404 |
| A caller whose login didn't match (simulated by changing the host's own login) | 403, and logged |
| After stop | Nothing listening |

So T3 (IPv6 binding) works on this machine.

**OPEN, not verified yet:**
- **T1. A request from the laptop over the tailnet.** My tests connected from the desktop to itself, which Windows Firewall doesn't filter. A connection from DylanLaptop may need the inbound firewall rule in the runbook (step 2.3). The laptop was online, but I can't run commands on it.
- **T2. `whois` for a peer.** I've only seen it for the desktop calling itself. It should return DylanLaptop and the same login.
- **T3. IPv6 from the laptop.** Binding works on the desktop (above); a laptop request over IPv6 is still to be seen.
- **T4. Tailscale not running at sign-in.** The retry is designed but untested. So is the case where the host's Tailscale address changes; Tailscale addresses are normally stable for a device.
- **T5. The CLI from the headless host.** The `tailscale` command is found under the sign-in task. The installer puts it in `C:\Program Files\Tailscale\` and on PATH; the app will fall back to that full path.
- **T6. Two "DylanLaptop" devices.** Your tailnet lists two, one offline. That's probably an old registration. Remove the stale one so the remote's identity is unambiguous (runbook step 1.4).

## 7. Setup runbook

You run these yourself. Step 0 works with build step 1. Steps 2.4, 3 and 4 need the later build steps.

### 0. Laptop test for build step 1 (T1, T2)

1. **On the desktop, restart `npm run dev`.** The host code is in the main process, so it needs a restart.
2. **Turn on the host.**
   1. Go to **Settings › Host** and tick **This machine is the host**.
   2. Leave the port at 47615 and choose **Save settings**.
   3. The section should say **Listening on 100.88.252.16:47615 and [fd7a:…]:47615**.
   4. If Windows Firewall asks to allow access, choose **Cancel**. Allowing would open every network; the rule in step 4 below covers Tailscale only.
3. **On the laptop** (Tailscale on and signed in as you), in PowerShell:
   ```powershell
   curl.exe -s --max-time 5 http://dylandesktop:47615/v1/host
   ```
   - **Pass for T1 and T2:** JSON where `caller.device` is your laptop (`dylanlaptop`) and `caller.login` is your Tailscale login. Settings › Host on the desktop then says "Last request from dylanlaptop".
   - **Times out:** Windows Firewall is blocking it, so do step 4 and try again.
   - **403:** the laptop is signed in to Tailscale as a different user. The desktop's log (`%APPDATA%\night-shift\logs\main.log`) has a `host: refused` line naming the device and login.
4. **Only if step 3 timed out:** on the desktop, in an admin PowerShell, add the Tailscale-only rule.
   - This first version has no `-Program`, so it works for `npm run dev` too.
   - Step 2.3 narrows it to the installed exe later.
   ```powershell
   New-NetFirewallRule -DisplayName "Night Shift host (Tailscale only)" -Direction Inbound -Action Allow `
     -Protocol TCP -LocalPort 47615 -RemoteAddress 100.64.0.0/10, fd7a:115c:a1e0::/48
   ```
5. **Negative checks, from the laptop:**
   ```powershell
   curl.exe -s --max-time 5 http://192.168.68.200:47615/v1/host            # desktop's Wi-Fi address: must fail
   curl.exe -s --max-time 5 "http://[fd7a:115c:a1e0::9b01:fcde]:47615/v1/host"   # IPv6 over Tailscale (T3): must work
   tailscale down; curl.exe -s --max-time 5 http://dylandesktop:47615/v1/host; tailscale up   # must fail while down
   ```
6. **Tell me the results.** Then I'll build the rest.

### 1. Tailscale on both machines

1. **Desktop:** Tailscale 1.104.5 is already installed and signed in. Nothing to do.
2. **Laptop:**
   1. Install Tailscale with `winget install --id Tailscale.Tailscale`, or from tailscale.com/download.
   2. Sign in with **the same account** as the desktop.
3. **Check** on each machine with `tailscale status`. Both `dylandesktop` and `dylanlaptop` should be listed and not offline.
4. **Tidy the device list.** In the Tailscale admin console (login.tailscale.com › **Machines**):
   1. remove the stale, offline **DylanLaptop** entry;
   2. on **dylandesktop**, choose **⋯ › Disable key expiry**, so the host doesn't drop off the tailnet when its key expires (180 days by default).
5. **MagicDNS** is already on in your tailnet (**DNS** page). Leave it on, because remotes use the host's name.

### 2. Host (desktop)

1. **Turn on hosting.** In Night Shift, **Settings › This machine is the host**:
   1. turn it on;
   2. check the name, and set the port (default 47615);
   3. choose **Save**.
   4. It shows the addresses it bound to, and **Copy connection**.
2. **Check it's bound to Tailscale only** (PowerShell):
   ```powershell
   Get-NetTCPConnection -LocalPort 47615 -State Listen | Select-Object LocalAddress, LocalPort
   ```
   Expect only `100.88.252.16` and an `fd7a:…` address. Never `0.0.0.0`, `::` or `127.0.0.1`.
3. **Allow inbound on the Tailscale range only, for the installed app.** This is step 0.4's rule, limited to the installed exe (section 8). In an admin PowerShell:
   ```powershell
   $exe = (Get-ChildItem "$env:LOCALAPPDATA\Programs" -Recurse -Filter "Night Shift.exe" | Select-Object -First 1).FullName
   $exe   # check the path it found
   Remove-NetFirewallRule -DisplayName "Night Shift host (Tailscale only)" -ErrorAction SilentlyContinue
   New-NetFirewallRule -DisplayName "Night Shift host (Tailscale only)" -Direction Inbound -Action Allow `
     -Protocol TCP -LocalPort 47615 -RemoteAddress 100.64.0.0/10, fd7a:115c:a1e0::/48 -Program $exe
   ```
   If Windows asks to allow access, choose **Cancel** and rely on this rule. That prompt would allow every network.
4. **Start the installed app headless at sign-in.** Normal PowerShell; it runs as you, only while you're signed in, and needs no password:
   ```powershell
   $exe = (Get-ChildItem "$env:LOCALAPPDATA\Programs" -Recurse -Filter "Night Shift.exe" | Select-Object -First 1).FullName
   $me  = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
   $action    = New-ScheduledTaskAction -Execute $exe -Argument "--headless"
   $trigger   = New-ScheduledTaskTrigger -AtLogOn -User $me
   $principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
   $settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
   Register-ScheduledTask -TaskName "Night Shift host" -Action $action -Trigger $trigger -Principal $principal -Settings $settings
   ```
   If it says access is denied, run the same lines in an admin PowerShell. The task still runs as you.
5. **Sign-in check:** restart and sign in. Step 2.2 shows the listener again without opening Night Shift. Opening Night Shift from the Start menu shows a window in the same process, not a second host.

### 3. Remote (laptop)

1. **Install Night Shift** from `https://nightshift-updates.dylanyoung.dev/download/NightShiftSetup.exe`.
2. **Point it at the host.** In **Settings › Mode**:
   1. choose **Remote**;
   2. paste `dylandesktop.tail1a8202.ts.net:47615`, or type `dylandesktop` and the port;
   3. choose **Test connection**. Expect "Connected to dylandesktop · Night Shift 0.x".
3. **Add the laptop's own Linear API key**, for the board.

### 4. Check it end to end

1. **From the laptop**, `curl.exe http://dylandesktop:47615/v1/host` returns the host's name and version.
2. **Over the LAN**, from the laptop, `curl.exe --max-time 5 http://192.168.68.200:47615/v1/host` fails. That's the desktop's Wi-Fi address; your router may assign another.
3. **Without Tailscale**, run `tailscale down` on the laptop, then step 1 again. It fails. Run `tailscale up` afterwards.
4. **On the laptop:**
   - start an action on a ticket, and watch the live log;
   - stop a run;
   - reply when one says **Needs you**;
   - continue a finished run.
5. **Edits:** edit an action's label on the laptop, and the desktop window shows it within a second. Then edit the same action on both machines without reloading. The second save shows the conflict message, and nothing is lost.
6. **Host off:** quit Night Shift on the desktop (stop the task). The laptop's board still loads, and runs show "Can't reach dylandesktop". Start it again, and the laptop reconnects within about 10 seconds.

### Turning it off fast

To stop the host starting at sign-in: `Disable-ScheduledTask -TaskName "Night Shift host"`.


Any one of these is enough:
- **In Night Shift,** on the desktop: turn off **Settings › This machine is the host**.
- **Tailscale:** run `tailscale down` on the desktop.
- **Admin console:** remove the device.
- **Firewall:** `Remove-NetFirewallRule -DisplayName "Night Shift host (Tailscale only)"`.

## 8. Additions agreed on 2026-11-18

**Build order**
1. **Done:**
   - the host definition (Settings › Host, in `settings.json › host`);
   - binding to Tailscale addresses only;
   - the `whois` caller check;
   - `GET /v1/host`.

   Code: `src/main/hostServer.ts`, wired in `src/main/index.ts`, with the Settings section in `SettingsView.tsx`.
2. **After your laptop test passes:**
   - the rest of the API, with `/events` and conflict checks;
   - remote mode in the app, including the per-machine board refresh interval;
   - headless start (`--headless` with the single-instance window);
   - the R1 error message.

**Installed build or source: the host runs the installed build.**
- **Why installed:**
  - it has a fixed exe path that the firewall rule and the sign-in task can name;
  - it auto-updates like the laptop;
  - restarting or breaking a development session doesn't take the host down.
- **Development stays on `npm run dev`, with one thing to know.** The installed app and the dev app use the **same data folder**, `%APPDATA%\night-shift`. Running both at once would mean two copies running agents on the same `runs.json`.
  - Until headless mode and the single-instance lock are built, stop the installed host before `npm run dev` with this machine's data.
  - Or run dev against a separate folder: `$env:NIGHTSHIFT_USER_DATA="$env:APPDATA\night-shift-dev"; npm run dev`. The app already supports that variable.
- **For step 0 only, the host is `npm run dev`.** That's why step 0.4's firewall rule has no `-Program`. Step 2.3 replaces it with the installed-exe version.
- **Not verified:** the installed exe path. Night Shift isn't installed on this desktop. The installer is per user, so it should be under `%LOCALAPPDATA%\Programs\`; the runbook finds it with `Get-ChildItem` rather than assuming.

**R1:** no fallback. A continue on a run whose Claude session is gone fails with a clear message on the remote and the host (section 2).

**Board refresh:** each machine has its own board refresh interval for Linear, default 5 minutes. The shared `pollSeconds` is for automations on the host only (sections 4 and 5).
