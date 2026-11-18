# Runbook: Night Shift on two machines

> **Superseded on 2026-11-18** by [remote-mode-plan.md](remote-mode-plan.md) (host and remote over Tailscale). Kept for reference only; this design will not be built.

This sets up shared storage and remote runs: one machine runs the agents (the **runner**), and Night Shift anywhere else is a **viewer**.

> **Draft.** It follows [two-machine-plan.md](two-machine-plan.md), including your decisions of 2026-11-18. Everything goes in your existing **AmplifyUp** Cloudflare account.
> - **Steps 1 and 4 to 7** use code that doesn't exist yet: the `worker/` folder, Night Shift's runner mode and the import command.
> - **Steps 2 and 3** (AWS and Cloudflare accounts) can be done now.
> - Run every step yourself; nothing here is automated.

## Placeholders

Replace these everywhere.

| Placeholder | Example | What it is |
|---|---|---|
| `<HOST>` | `nightshift.amplifyup.ai` | Base hostname. `amplifyup.ai` must be a zone in your AmplifyUp Cloudflare account. |
| `api.<HOST>` | `api.nightshift.amplifyup.ai` | The Worker API. |
| `hook.<HOST>` | `hook.nightshift.amplifyup.ai` | The runner's hook, through the Tunnel. |
| `<CF_ACCOUNT_ID>` | | Cloudflare account id (dashboard, right-hand column of any zone). |
| `<TEAM>` | `amplifyup` | Your Zero Trust team name, so the team domain is `<TEAM>.cloudflareaccess.com`. |
| `<BUCKET>` | `nightshift-run-output-<random>` | S3 bucket name (globally unique). |
| `<AWS_REGION>` | `us-east-1` | |
| `<RUNNER_NAME>` | `desktop-dy` | Name of this runner. |
| `<HOOK_PORT>` | `47615` | Local port the runner listens on, on 127.0.0.1 only. |

Secrets (token secrets, AWS keys) appear on screen **once**. Paste each straight into the place this runbook names. Never put them in the repo, in `.env` files that get committed, or in chat.

---

## 1. Cloudflare: D1 database and the Worker

Run in a terminal in the repo, in `worker/`. You need Node 20+.

1. **Log in to Wrangler:**
   ```powershell
   npx wrangler login
   ```
   This opens a browser to approve. To use an API token instead, give it *Workers Scripts: Edit*, *D1: Edit* and *Workers Routes: Edit*, and set it only for the session: `$env:CLOUDFLARE_API_TOKEN="<token>"`.
2. **Confirm Workers Paid is active** in the AmplifyUp account: dashboard › **Workers & Pages › Plans**. If it isn't, subscribe ($5/month). It's needed because the Free plan caps a D1 database at 500 MB; see the plan's cost section.
3. **Create the database:**
   ```powershell
   npx wrangler d1 create nightshift
   ```
   Copy the `database_id` it prints into `worker/wrangler.toml` under `[[d1_databases]]` (binding `DB`, name `nightshift`). The id isn't a secret.
4. **Create the tables:**
   ```powershell
   npx wrangler d1 migrations apply nightshift --remote
   ```
   Check:
   ```powershell
   npx wrangler d1 execute nightshift --remote --command "select name from sqlite_master where type='table'"
   ```
   It should list `settings projects actions action_versions automations automation_versions automation_state runners requests runs` (plus `replies` if chosen).
5. **Check `wrangler.toml` has these lines:**
   ```toml
   workers_dev = false          # no *.workers.dev address
   preview_urls = false
   routes = [{ pattern = "api.<HOST>", custom_domain = true }]
   [triggers]
   crons = ["*/5 * * * *"]      # dead-run sweep and fallback hook
   ```
6. **Deploy:**
   ```powershell
   npx wrangler deploy
   ```
   Cloudflare creates the `api.<HOST>` DNS record and certificate for the custom domain.
7. **Set the secrets.** Each command prompts for the value; paste it there. The AWS values come from step 2, the token values from step 3, so come back to this after those steps.
   ```powershell
   npx wrangler secret put AWS_ACCESS_KEY_ID
   npx wrangler secret put AWS_SECRET_ACCESS_KEY
   npx wrangler secret put HOOK_CLIENT_ID          # service token "nightshift-hook" (step 3.3)
   npx wrangler secret put HOOK_CLIENT_SECRET
   ```
8. **Set the plain config values.** These aren't secrets; put them in `wrangler.toml` under `[vars]`:
   - `S3_BUCKET = "<BUCKET>"` and `S3_REGION = "<AWS_REGION>"`
   - `ACCESS_TEAM_DOMAIN = "https://<TEAM>.cloudflareaccess.com"`
   - `ACCESS_AUD_API = "<aud tag of the API applications, step 3.5>"`
   - `HOOK_URL = "https://hook.<HOST>/check"`
   - `TOKENS = '{"<client id>":{"role":"runner","name":"<RUNNER_NAME>"}, …}'`. This maps Client IDs to roles; Client IDs aren't secret.

   Redeploy after changing them.

## 2. AWS: private bucket and a scoped user

In the AWS console, signed in as an admin of your account.

1. **Create the bucket.** **S3 › Create bucket**:
   - **Name:** `<BUCKET>`. **Region:** `<AWS_REGION>`.
   - **Object Ownership:** ACLs disabled.
   - **Block Public Access:** all four boxes **on**.
   - **Versioning:** off.
   - **Default encryption:** SSE-S3.
   - Choose **Create**.
   - Don't add a lifecycle rule; deletion is manual by design.
2. **Create a policy.** **IAM › Policies › Create policy › JSON**, name it `nightshift-worker-s3`:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Sid": "RunOutputObjects",
       "Effect": "Allow",
       "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
       "Resource": "arn:aws:s3:::<BUCKET>/runs/*"
     }]
   }
   ```
   - There's no `s3:ListBucket`, so the key can't list the bucket. A check for a missing object answers 403 instead of 404; the Worker treats both as "not there".
3. **Create the user.** **IAM › Users › Create user** `nightshift-worker`:
   - No console access.
   - **Attach policies directly:** `nightshift-worker-s3`.
4. **Create its access key.** On the user: **Security credentials › Create access key**:
   - Use case: **Application running outside AWS**.
   - Copy the **Access key ID** and **Secret** straight into step 1.7 (`wrangler secret put …`). Don't save them anywhere else.
5. **Optional:** add a billing alert. **Billing › Budgets**: a $5/month budget with email alerts.

## 3. Cloudflare: Tunnel, hostnames, Access and service tokens

### 3.1 Turn on Zero Trust

1. Dashboard › **Zero Trust**.
2. Pick the team name `<TEAM>` and the **Free** plan (50 users). It asks for a payment method even on Free.

### 3.2 Create the Tunnel to the runner

1. **Zero Trust › Networks › Tunnels › Create a tunnel › Cloudflared**, name `nightshift-<RUNNER_NAME>`.
2. **On the runner machine**, in an **admin** PowerShell, run the install command the dashboard shows:
   ```powershell
   winget install --id Cloudflare.cloudflared
   cloudflared.exe service install <TUNNEL_TOKEN>
   ```
   - This installs cloudflared as a Windows service that starts with the machine, holding its own token.
   - The tunnel shows **Healthy** in the dashboard.
3. **Public Hostname › Add:**
   - **Subdomain:** `hook.nightshift`. **Domain:** `amplifyup.ai`.
   - **Service:** `HTTP`, `localhost:<HOOK_PORT>`.
   - There are no inbound ports to open; cloudflared only connects out.

### 3.3 Create the service tokens

1. **Zero Trust › Access › Service credentials › Service Tokens › Create Service Token.**
2. Create each token below with duration **1 year**. For each, copy the **Client ID** and **Client Secret** (shown once) to where it goes.

| Token name | Used by | Goes to |
|---|---|---|
| `nightshift-hook` | The Worker, calling the runner's hook | Worker secrets `HOOK_CLIENT_ID`, `HOOK_CLIENT_SECRET` (step 1.7) |
| `nightshift-runner-<RUNNER_NAME>` | The runner, calling the API | Night Shift on the runner (step 5) |
| `nightshift-viewer-<machine>` | Each viewer (laptop) | Night Shift on that viewer (step 6) |
| `nightshift-admin` | Whoever edits actions and automations | Night Shift on the machine you edit from |

3. Add every Client ID to `TOKENS` in `wrangler.toml` with its role (step 1.8).
4. Put a reminder in your calendar for 11 months from now: rotate the tokens (section 8).

### 3.4 Protect the hook

1. **Zero Trust › Access › Applications › Add an application › Self-hosted:**
   - **Name:** `Night Shift runner hook`. **Domain:** `hook.<HOST>`.
   - **Policy:** name `Worker only`, **Action: Service Auth**, **Include:** Service Token = `nightshift-hook`.
2. Leave identity providers unset. Session duration doesn't matter for service tokens.

### 3.5 Protect the API

Create three self-hosted applications on the same hostname, each with **Action: Service Auth**. The most specific path should win; step 3.6 checks that.

| Application | Domain and path | Include (Service Token) |
|---|---|---|
| `Night Shift API (runner)` | `api.<HOST>` / `v1/runner` | every `nightshift-runner-*` token |
| `Night Shift API (admin)` | `api.<HOST>` / `v1/admin` | `nightshift-admin` |
| `Night Shift API` | `api.<HOST>` (no path) | all viewer tokens, `nightshift-admin`, and runner tokens |

- On each application's **Overview** tab, copy its **Application Audience (AUD) tag** into the Worker's `ACCESS_AUD_API` var. If the three tags differ, list all three, comma-separated.

### 3.6 Confirm unauthenticated requests are blocked at Cloudflare

Run these from any machine. `curl.exe` is built into Windows.

```powershell
# 1. No token: Access must answer, not the Worker or your PC.
curl.exe -i https://api.<HOST>/v1/runs
curl.exe -i -X POST https://hook.<HOST>/check
```
- Expect `302` to `<TEAM>.cloudflareaccess.com` or `403`, never `200`.
- On the runner, the Night Shift log (`%APPDATA%\night-shift\logs\main.log`) must show **no** hook call.

```powershell
# 2. Viewer token on a runner path: must be refused (proves the path-scoped app wins).
curl.exe -i -X POST https://api.<HOST>/v1/runner/claim -H "CF-Access-Client-Id: <VIEWER_ID>" -H "CF-Access-Client-Secret: <VIEWER_SECRET>"
```
- Expect `403`.
- If it returns `200` or reaches the Worker, path precedence isn't working: stop here, because the design needs a change. The Worker's own role check would still refuse it, but the brief wants Cloudflare to block it.

```powershell
# 3. Viewer token on a viewer path: allowed.
curl.exe -i https://api.<HOST>/v1/runs -H "CF-Access-Client-Id: <VIEWER_ID>" -H "CF-Access-Client-Secret: <VIEWER_SECRET>"
```
- Expect `200` with JSON.

```powershell
# 4. The workers.dev address must not exist.
curl.exe -i https://nightshift.<your-subdomain>.workers.dev/v1/runs
```
- Expect an error or 404, not 200.

Clear these commands from your PowerShell history afterwards: `Clear-History`, then delete `(Get-PSReadLineOption).HistorySavePath`. They contain secrets.

## 4. Move the existing data

Do this on the desktop, which holds the current data, **after you've approved the triage table**.

1. In Night Shift: **Settings › Shared store**:
   - Enter `https://api.<HOST>` and the **admin** token (Client ID and Secret).
   - Choose **Save**. The secret is stored encrypted for your Windows user.
2. Choose **Copy this machine's data to the shared store**. It shows what it will copy:
   - actions from `auto-personalization-poc\.nightshift\steps.yml`;
   - projects and shared settings;
   - automations, switched off.

   No runs are copied (decision O5). The local `runs\` folder stays as it is.
3. Confirm. It's safe to run twice, because it skips anything already there by id.
4. **Check the counts:**
   ```powershell
   npx wrangler d1 execute nightshift --remote --command "select (select count(*) from actions) actions, (select count(*) from automations) automations, (select count(*) from projects) projects, (select count(*) from runs) runs"
   ```
   Expect 5 actions, 1 project, 0 automations (none exist yet) and 0 runs.
5. **Check the shared settings:**
   ```powershell
   npx wrangler d1 execute nightshift --remote --command "select key, value from settings"
   ```
   Expect `linear_team_key` = `"IGN"`, `base_branch` = `"releases/nov-2026"`, `worktree_mode` = `"agent"` and `output_d1_max_bytes` = `1572864`.
6. **`steps.yml` is no longer used.** From now on Night Shift neither reads nor writes `auto-personalization-poc\.nightshift\steps.yml` (decision O2). Delete it, or leave it; it changes nothing either way.

## 5. Runner machine: install and start the runner

1. **Install Night Shift** from `https://nightshift-updates.dylanyoung.dev/download/NightShiftSetup.exe`.
2. **Set up Night Shift** (Settings):
   - **Role:** Runner.
   - **API:** `https://api.<HOST>`, with the runner token.
   - **Repo path, worktree path, concurrency limit:** this machine's values.
   - **Linear API key.**
   - **Hook port:** `<HOOK_PORT>`.

   Close Night Shift.
3. **Check Claude Code works from a plain terminal:**
   ```powershell
   cd C:\Development\auto-personalization-poc
   claude -p "Reply with OK" --output-format json
   ```
4. **Find the installed exe:**
   ```powershell
   Get-ChildItem "$env:LOCALAPPDATA\Programs" -Recurse -Filter "Night Shift.exe" | Select-Object FullName
   ```
5. **Create the sign-in task.** Normal (not admin) PowerShell. No password is needed: it runs in your own session, only while you're signed in.
   ```powershell
   $exe  = "<full path from step 4>"
   $me   = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
   $action    = New-ScheduledTaskAction -Execute $exe -Argument "--runner"
   $trigger   = New-ScheduledTaskTrigger -AtLogOn -User $me
   $principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
   $settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
   Register-ScheduledTask -TaskName "Night Shift runner" -Action $action -Trigger $trigger -Principal $principal -Settings $settings
   Start-ScheduledTask -TaskName "Night Shift runner"
   ```
   - If `Register-ScheduledTask` says access is denied, run the same lines in an admin PowerShell. The task still runs as you, not as admin.
6. **Keep the machine awake:**
   ```powershell
   powercfg /change standby-timeout-ac 0
   ```
7. **Confirm it registered** (viewer token):
   ```powershell
   curl.exe -s https://api.<HOST>/v1/runners -H "CF-Access-Client-Id: <VIEWER_ID>" -H "CF-Access-Client-Secret: <VIEWER_SECRET>"
   ```
   - Expect `<RUNNER_NAME>` with `"status":"online"` and a `last_heartbeat_at` within the last 30 seconds.
8. **Sign-in test:**
   1. Restart the desktop and sign in.
   2. Within a minute, repeat step 7: `online`, without opening Night Shift.
   3. Open the Night Shift window too. It opens as a viewer, and step 7 still shows **one** runner, not two.
   4. Close the window. The runner stays `online`.

## 6. Viewer machine (laptop)

1. **Install Night Shift.** Open **Settings**:
   - **Role:** Viewer.
   - **API:** `https://api.<HOST>`, with this laptop's viewer token (or the admin token, if you'll edit actions here).
   - **Linear API key:** this machine's own, for the board.
2. **Check:**
   - The **Actions** and **Automations** pages show the same entries as the desktop.
   - **Runners** shows `<RUNNER_NAME>` online.

## 7. End-to-end test

1. **Small output (D1):**
   1. On the laptop, open a ticket in a state that has an action (for example Planner), and choose the action.
   2. Within a few seconds the run shows **Running on `<RUNNER_NAME>`**. That proves the hook woke the runner and it claimed the request.
   3. When it ends, open the run and choose **Full output**. It loads from the API.
   4. Check where it was stored:
      ```powershell
      npx wrangler d1 execute nightshift --remote --command "select id, output_location, output_bytes from runs order by started_at desc limit 1"
      ```
      Expect `d1`.
2. **Large output (S3).** The quick way: with the admin token, set **Settings › Shared store › Output cutoff** to `10000` bytes, run any action, check that it goes to S3 (step 2.3 below), and set the cutoff back to `1572864`. To test with real large output instead:
   1. With the admin token, add a temporary **global** action `Output size test` with one script step:
      ```
      node -e "for(let i=0;i<40000;i++)console.log(i.toString().padStart(60,'x'))"
      ```
      That prints about 2.4 MB.
   2. Run it from the laptop's **Run action** menu.
   3. Check: `output_location` is `s3`, and `output_bytes` > 1572864.
   4. Then check the object:
      ```powershell
      aws s3 ls s3://<BUCKET>/runs/ --recursive
      ```
      Run this with your admin AWS login, not the Worker's key.
   5. **Full output** on the laptop shows all 40,000 lines; the last one ends in `39999`.
   6. Delete the test action afterwards.
3. **Same actions and automations everywhere:**
   1. Edit an action's button label with the admin token.
   2. Both machines show the new label after their next refresh.
   3. `select action_id, version from action_versions order by created_at desc limit 1` shows the new version.
4. **Cancel:** start a run and press **Stop** on the laptop. Within about 30 seconds it shows **Stopped**, and the `claude` process is gone on the runner:
   ```powershell
   Get-Process claude -ErrorAction SilentlyContinue
   ```
5. **Reply to a waiting run:**
   1. Start an action that asks you something, such as Planner on a ticket with no spec.
   2. When the laptop shows **Needs you**, type a reply and send it.
   3. Within a few seconds the run goes back to **Running**.
   4. When it ends, **Full output** contains your reply as a `▶ You:` line.
6. **Continue a finished run, resuming the session:**
   1. On a finished run from step 1, choose **Continue** on the laptop and type a short follow-up, for example "Add one more test case".
   2. A new run appears under the old one, on the same runner, with **Resumed session**.
   3. Check:
      ```powershell
      npx wrangler d1 execute nightshift --remote --command "select id, continues_run_id, continue_mode from runs order by started_at desc limit 1"
      ```
      Expect `continue_mode` = `resume`.
7. **Continue a finished run, in a new session:**
   1. Make resume impossible: on the runner, rename that run's Claude transcript in `%USERPROFILE%\.claude\projects\…\<session id>.jsonl` (add `.bak`).
   2. Continue the same run again from the laptop.
   3. The new run shows **New session (earlier transcript as context)**, and its output starts with Claude reading `previous-run.txt`.
   4. `continue_mode` = `new_session`.
   5. Rename the file back afterwards.
8. **Dead run:**
   1. Start a run, then end the runner task on the desktop:
      ```powershell
      Stop-ScheduledTask -TaskName "Night Shift runner"
      ```
   2. Within about 8 minutes the run shows **Failed: runner stopped responding**.
   3. Start the task again. The runner applies the failure plan to the Linear ticket.

## 8. Rotating keys, and shutting everything off fast

### Rotate

| Key | How |
|---|---|
| A service token (viewer, runner, admin, hook) | Create a new token (step 3.3) and add it to the same Access policies and to `TOKENS`, then deploy. Put the new one in Night Shift (or the hook secrets), check it works, then delete the old token under **Service Tokens**. *Refresh* only extends the expiry date; it doesn't change the secret. |
| AWS access key | IAM › the user › **Create access key** (a user can have two). Run `npx wrangler secret put AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` with the new key. Run test 7.2. Then **Deactivate** the old key, wait a day, and **Delete** it. |
| Tunnel token | Zero Trust › Tunnels › the tunnel › **Refresh token** (if offered), or create a new tunnel, move the hostname to it and delete the old one. On the runner: `cloudflared.exe service uninstall`, then `cloudflared.exe service install <new token>`. |
| Linear keys | In Linear › Settings › API, revoke and create. Enter the new one in Night Shift on that machine. |

### If a key leaks: shut off fast, in this order

1. **Delete the leaked service token:** Zero Trust › Access › Service Tokens › Delete. Access refuses it at once, before anything reaches the Worker or your PC.
2. **Stop new runs at the runner,** if the runner or admin token leaked: on the desktop, `Disable-ScheduledTask -TaskName "Night Shift runner"` and end any running `Night Shift.exe --runner`.
3. **Cut the hook:** in an admin shell, `Stop-Service cloudflared`. Or delete the `hook.<HOST>` public hostname.
4. **Cut S3,** if the AWS key leaked: `aws iam update-access-key --user-name nightshift-worker --access-key-id <ID> --status Inactive`, or deactivate it in the console.
5. **Stop the Worker entirely,** if needed: dashboard › Workers › `nightshift` › **Settings › Domains & Routes**, remove `api.<HOST>`. Or run `npx wrangler delete nightshift`; the D1 data is kept.
6. **Check what changed:**
   - New action and automation versions: `select * from action_versions order by created_at desc limit 10`, and the same for automation versions.
   - Recent requests: `select requested_by, created_at from requests order by created_at desc limit 50`.
   - The hard rule: if any action version was changed by someone else, **don't restart the runner** until you've restored the previous version.
