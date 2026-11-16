# Runbook: Cloudflare setup for Night Shift releases

This sets up the hosting that `npm run release` uploads to and that installed copies update from: a **Cloudflare R2** bucket served on your own domain. You do it once. To release afterwards, see [releasing.md](releasing.md).

| What | Value |
| --- | --- |
| R2 bucket | `nightshift-desktop-updates` |
| Public URL (built into the app) | `https://nightshift-updates.dylanyoung.dev` |
| Latest-installer link | `https://nightshift-updates.dylanyoung.dev/download/NightShiftSetup.exe` |
| Local credentials | an R2 API token, in `.env` in the repo root (git-ignored) |
| Releases kept | the newest 5; the release script removes older ones |

All you need is a Cloudflare account. Night Shift's scripts talk to R2 directly, so there are no other tools to install.

## 0. Before you start

- **`dylanyoung.dev` must be a zone in your Cloudflare account,** with Cloudflare as its DNS. R2 can only serve a custom domain from a zone in the same account.
  - Check: **Websites** lists `dylanyoung.dev` as **Active**.
  - If it doesn't: add the site there, switch the domain's nameservers at your registrar to the two Cloudflare gives you, and wait until it's Active.
- **R2 needs a payment method on file,** even within the free tier. Add one under **R2 Object Storage › Overview › Purchase R2 Plan**. The free tier is enough here.

## 1. Create the bucket

1. Open **R2 Object Storage › Create bucket**.
2. Fill in:
   - **Name:** `nightshift-desktop-updates`.
   - **Location:** Automatic.
   - **Default storage class:** Standard.
3. Choose **Create bucket**.

New buckets are private. Nothing can be read until you connect the domain in step 2.

## 2. Connect the custom domain

1. Open the bucket, then go to **Settings › Custom Domains › Add**.
2. Enter `nightshift-updates.dylanyoung.dev`, then choose **Continue › Connect domain**.
3. Wait until the status shows **Active**. This usually takes a minute or two.

Cloudflare creates the DNS record and the certificate for you. There's nothing to add by hand.

On the same Settings page, leave **Public Development URL** (`r2.dev`) **disabled**. The custom domain is the only public address.

## 3. Don't cache the files that change

Installer files never change once they're uploaded, so Cloudflare can cache them. But `latest.yml` and the download link change with every release, so they need to skip the cache:

1. In the **`dylanyoung.dev`** zone, go to **Caching › Cache Rules › Create rule**.
2. **Rule name:** `Night Shift update files: no cache`.
3. Under **Custom filter expression**, choose **Edit expression** and paste:
   ```
   (http.host eq "nightshift-updates.dylanyoung.dev" and http.request.uri.path in {"/latest.yml" "/download/NightShiftSetup.exe"})
   ```
4. **Cache eligibility:** Bypass cache.
5. Choose **Deploy**.

With this rule, a release reaches installed apps as soon as it's uploaded, and so does a rollback. You never need to purge the cache.

## 4. Create an R2 API token

1. Go to **R2 Object Storage › Overview › Manage API tokens** (under "Account details"), then choose **Create Account API token**.
2. Fill in:
   - **Token name:** `night-shift-release`
   - **Permissions:** Object Read & Write
   - **Specify bucket(s):** Apply to specific buckets only, then choose `nightshift-desktop-updates`
   - **TTL:** Forever. You can set an expiry instead, and make a new token when it runs out.
3. Choose **Create API Token**. Copy these, because they're shown only once:
   - **Access Key ID**
   - **Secret Access Key**
4. Copy your **Account ID** as well. It's on the R2 overview page, under "Account details".

The token can upload, copy and delete files in that one bucket, and do nothing else. Keep it out of git: step 5 saves it in a git-ignored `.env` file.

## 5. Save the token on this computer

Create a file named `.env` in the repo root with the three values from step 4:

```
R2_ACCOUNT_ID=<Account ID>
R2_ACCESS_KEY_ID=<Access Key ID>
R2_SECRET_ACCESS_KEY=<Secret Access Key>
```

- **Git:** `.env` is in `.gitignore`, so it's never committed.
- **The app:** `.env` isn't packaged into the installer either.
- **Priority:** environment variables with the same names override the file.

## 6. Check the setup

```powershell
npm run r2 -- check
```

It does the following, then deletes its test file:

1. Checks the token can reach the bucket.
2. Uploads a test file.
3. Reads the file back through `https://nightshift-updates.dylanyoung.dev`.
4. Checks `latest.yml` skips the cache.

Every line should start with ✓. Any line that starts with ✗ or ! names the step to recheck.

## 7. First release, and checking auto-update

1. Commit everything. The release script refuses to run with uncommitted changes.
2. Run the release:
   ```powershell
   npm run release
   ```
3. Check it's listed:
   ```powershell
   npm run r2 -- list
   ```
   This shows each release in the bucket and marks the one `latest.yml` points at.
4. Install from the latest-installer link. SmartScreen warns because the installer isn't code-signed yet: choose **More info › Run anyway**.
5. Make any small change, commit it, and run `npm run release` again. Open the installed app. Within a minute or two it shows **"Update ready, restart to install"**.

The installed app and `npm run dev` share `%APPDATA%
ight-shift`. Don't run both at once, or both will poll Linear and run automations.

## Troubleshooting

| What you see | Likely cause | Fix |
| --- | --- | --- |
| **"Missing R2_ACCOUNT_ID…"** | `.env` is missing, or a name in it is misspelled. | Check `.env` against step 5. |
| **401 / 403**, or `InvalidAccessKeyId` / `SignatureDoesNotMatch` | The token was deleted, has expired or was copied wrong, or isn't allowed on this bucket. | Make a new token (step 4) and update `.env` (step 5). |
| **404 NoSuchBucket** | The bucket name differs, or the account ID is for a different account. | Check the bucket is named `nightshift-desktop-updates`, and check `R2_ACCOUNT_ID`. |
| The public URL gives **404** for a file that's in the bucket | The custom domain isn't **Active**, or it's connected to a different bucket. | Check the bucket's **Settings › Custom Domains**. |
| The public URL gives a **DNS or certificate error** | The zone isn't on Cloudflare, or the domain was never connected. | Check steps 0 and 2. |
| Installed apps don't see a release | The cache rule is missing, so the old `latest.yml` is still cached. | Add the rule (step 3). For an immediate fix, use **Caching › Configuration › Custom Purge** for `https://nightshift-updates.dylanyoung.dev/latest.yml`. |
| Updates download the full ~120 MB each time | The previous release's blockmap is gone, or `useMultipleRangeRequest: false` was removed. | Keep the setting. The release script keeps the newest 5 releases, so the previous one is always there. |
| An installed app logs `updater:` errors | It's offline, or the feed can't be reached. | See `%APPDATA%\night-shift\logs\main.log`. It tries again every 6 hours. |

### Point the latest-installer link at another release

The release script does this automatically. Do it by hand to fix the link, or to make the link serve an older version:

```powershell
npm run r2 -- link 0.1.4
```

The cache rule means it takes effect straight away.

## Cost and exposure

- **Cost:** $0 at this size. R2's free tier is 10 GB of storage plus millions of requests a month, and R2 never charges for downloads. Five releases take about 600 MB.
- **Keeping fewer or more releases:** set `NIGHTSHIFT_KEEP_RELEASES` before `npm run release`. Keep at least 2, so updates can download only what changed.
- **Who can download:** anyone who has the URL. The bucket is served read-only on the custom domain, and the `r2.dev` address stays off. The installer has no secrets in it: Linear keys and settings stay on each computer.
