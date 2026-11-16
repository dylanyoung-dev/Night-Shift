# Releasing Night Shift

Night Shift is released from this machine. There's no CI. A release builds the Windows installer and uploads it to a Cloudflare R2 bucket. Installed copies then update themselves from that bucket's custom domain.

| | |
| --- | --- |
| Bucket | `nightshift-desktop-updates` (Cloudflare R2) |
| Update URL | `https://nightshift-updates.dylanyoung.dev`, the bucket's custom domain on Cloudflare |
| Download link | `https://nightshift-updates.dylanyoung.dev/download/NightShiftSetup.exe`, always the newest installer |
| Releases kept | The newest 5. Change it with `NIGHTSHIFT_KEEP_RELEASES`. |
| Config | `electron-builder.yml` (build), `scripts/release.mjs` and `scripts/r2.mjs` (upload) |
| App log | `%APPDATA%\night-shift\logs\main.log`. Updater events are logged here. |

## Before the first release

Set up the bucket, the domain, the cache rule and your R2 token with [cloudflare-runbook.md](cloudflare-runbook.md). You only do this once.

Keys are never committed. They live in `.env` in the repo root (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`), which git ignores.

## Release

```powershell
npm run release
```

`npm run release` (`scripts/release.mjs`) does this:

1. **Checks git.** It stops if anything is uncommitted.
2. **Checks R2.** It confirms it can reach the bucket before changing anything.
3. **Bumps the version.** It runs `npm version patch`, which makes the `Release x.y.z` commit and the `vx.y.z` tag.
4. **Builds.** It runs `electron-vite build`, then `electron-builder --win --publish never`.
5. **Uploads.** It uploads the installer, the blockmap, a copy of `latest.yml` (`history/latest-x.y.z.yml`, for rollbacks), and finally `latest.yml`. `latest.yml` goes last, so installed apps never see a release before its installer is there.
6. **Updates the download link.** It copies the installer to `download/NightShiftSetup.exe`.
7. **Removes old releases.** It deletes the installer, blockmap and history copy of everything older than the newest 5 releases.
8. **Pushes.** It pushes the commit and the tag to `origin`.

There's no cache to refresh. A Cloudflare cache rule means `latest.yml` and the download link are never cached (see the runbook, step 3).

If the build or upload fails, the commit and tag stay local only. The script prints how to undo them:

```
git tag -d vx.y.z
git reset --hard HEAD~1
```

### What's in the bucket

| File | What it is |
| --- | --- |
| `Night Shift Setup x.y.z.exe` | The installer: a one-click, per-user install with no admin prompt. |
| `Night Shift Setup x.y.z.exe.blockmap` | The block map. It lets the next version download only the parts that changed, about 1 MB instead of about 120 MB. |
| `latest.yml` | Tells installed apps the newest version, its file and its checksum. **Installed apps only update when this file changes.** |
| `history/latest-x.y.z.yml` | A copy of each release's `latest.yml`, for rolling back. |
| `download/NightShiftSetup.exe` | A copy of the newest installer, at a link that never changes, for first installs. |

The last 5 releases' installers, blockmaps and history files are kept. An update needs the previous version's blockmap, and a rollback needs an older installer.

## How installed apps update

- **When it checks:** on launch, then every 6 hours. Only installed copies check; `npm run dev` never does.
- **What it reads:** `app-update.yml`, built into the app. It points at the update URL (generic provider).
- **Downloading:** happens in the background. A banner then says **"Update ready, restart to install"**:
  - **Restart** installs the update silently and reopens the app.
  - **Later** hides the banner. If you ignore it, the update installs the next time you quit.
- **Offline, or the feed is down:** the failure goes to the app log. There's no dialog, and it tries again at the next check.
- **Current version:** shown in Settings › About.

## Roll back

Point `latest.yml` back at an earlier release:

```powershell
npm run r2 -- list            # the releases you can roll back to
npm run r2 -- rollback 0.1.4
```

It takes effect straight away, because `latest.yml` isn't cached. Only the last 5 releases can be rolled back to.

**Rolling back only protects copies that haven't updated yet.** The updater never installs an older version than the one running, so a copy already on the bad release stays on it. To fix those copies, either:

- **Roll forward:** fix the problem and run `npm run release` again. The new patch version is higher, so every copy takes it. This is usually best.
- **Reinstall the older version by hand:** download `https://nightshift-updates.dylanyoung.dev/Night%20Shift%20Setup%200.1.4.exe` and run it. It installs over the newer version. Settings and run history stay, because they live in `%APPDATA%\night-shift`.

## Build without releasing

```powershell
npm run dist      # dist\Night Shift Setup x.y.z.exe, nothing uploaded
npm run dist:dir  # unpacked app in dist\win-unpacked, the quickest to try
```

Neither needs Cloudflare credentials.

The installer isn't code-signed yet, so Windows SmartScreen warns the first time: choose **More info › Run anyway**. The build is configured to skip signing, so a missing certificate never fails it.

## Testing an update locally

Two environment variables point an installed copy at a local folder instead of the update URL. They're for testing only:

- `NIGHTSHIFT_UPDATE_URL`: the update feed, for example a static server on `http://127.0.0.1:8765` serving a `dist` folder from a higher version.
- `NIGHTSHIFT_USER_DATA`: a separate data folder, so the test copy doesn't use your real settings or run automations.

To build test versions without bumping `package.json`:

```powershell
npx electron-builder --win --publish never -c.extraMetadata.version=0.0.2 -c.directories.output=C:\temp\v0.0.2
```

Use versions lower than the real one, and uninstall the test copy afterwards, so it doesn't hide a real release.
