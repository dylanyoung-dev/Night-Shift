#!/usr/bin/env node
// npm run release: bump the patch version, build the Windows installer, upload it to Cloudflare R2
// and push the version commit and tag. Needs only an R2 API token, in the user environment
// variables R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY (never the repo).
// See docs/releasing.md and docs/cloudflare-runbook.md.
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { BUCKET, DOWNLOAD_KEY, PUBLIC_URL, compareVersions, installerKey, linkOptions, r2, versionOf } from './r2.mjs'

const KEEP = Math.max(2, Number(process.env.NIGHTSHIFT_KEEP_RELEASES) || 5) // releases kept in the bucket

const run = (cmd) => execSync(cmd, { stdio: 'inherit' })
const out = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim()
function fail(msg) {
  console.error(`\n✗ ${msg}\n`)
  process.exit(1)
}
const step = (msg) => console.log(`\n▸ ${msg}`)

// 1. Clean tree only.
step('Checking git')
if (out('git status --porcelain')) fail('There are uncommitted changes. Commit or stash them, then run the release again.')
const branch = out('git rev-parse --abbrev-ref HEAD')
console.log(`  on ${branch}, nothing uncommitted`)

step('Checking R2 access')
let client
try {
  client = r2()
  await client.checkBucket()
} catch (err) {
  fail(`${err.message}\n  Test the setup with:  npm run r2 -- check`)
}
console.log(`  bucket ${BUCKET} is reachable`)

// 2. Bump the patch version (makes the commit and the tag).
step('Bumping the patch version')
run('npm version patch -m "Release %s"')
const version = JSON.parse(readFileSync('package.json', 'utf8')).version
const tag = `v${version}`
const undo = `    git tag -d ${tag}\n    git reset --hard HEAD~1`

// 3. Build the installer.
try {
  step(`Building Night Shift ${version}`)
  run('npx electron-vite build')
  run('npx electron-builder --win --publish never')
} catch {
  fail(`The build failed. Nothing was uploaded, and the version commit and tag are local only. To undo them:\n${undo}`)
}
const exe = installerKey(version)
const files = [`dist/${exe}`, `dist/${exe}.blockmap`, 'dist/latest.yml']
for (const f of files) if (!existsSync(f)) fail(`The build didn't make ${f}. To undo the version commit and tag:\n${undo}`)

// Upload. latest.yml goes last: installed apps act on it, so the installer must be there first.
step('Uploading to R2')
try {
  for (const [file, key, contentType] of [
    [files[0], exe, 'application/octet-stream'],
    [files[1], `${exe}.blockmap`, 'application/octet-stream'],
    [files[2], `history/latest-${version}.yml`, 'text/yaml'], // kept for rollbacks
    [files[2], 'latest.yml', 'text/yaml']
  ]) {
    process.stdout.write(`  ${key} … `)
    await client.put(key, file, { contentType })
    console.log('done')
  }
} catch (err) {
  fail(
    `Upload failed: ${err.message}\n  The version commit and tag are local only. To undo them:\n${undo}\n` +
      `  Installed apps only move when latest.yml changes, so a half-finished upload doesn't affect them.`
  )
}

// A link that never changes, for first installs. It downloads under the versioned name.
step('Updating the download link')
try {
  await client.copy(exe, DOWNLOAD_KEY, linkOptions(version))
  console.log(`  ${PUBLIC_URL}/${DOWNLOAD_KEY} now serves ${version}`)
} catch (err) {
  console.log(`  ! couldn't update it (${err.message}). Fix later with:  npm run r2 -- link ${version}`)
}

// Only the newest few releases are kept: older installers, blockmaps and history copies go.
step(`Removing releases older than the newest ${KEEP}`)
try {
  const keys = await client.list()
  const versions = [...new Set(keys.map(versionOf).filter(Boolean))].sort(compareVersions).reverse()
  const kept = new Set(versions.slice(0, KEEP))
  kept.add(version) // never this release, whatever the numbering
  const old = keys.filter((k) => versionOf(k) && !kept.has(versionOf(k)))
  for (const k of old) {
    await client.remove(k)
    console.log(`  removed ${k}`)
  }
  if (!old.length) console.log(`  nothing to remove (${versions.length} release${versions.length === 1 ? '' : 's'} in the bucket)`)
} catch (err) {
  console.log(`  ! couldn't tidy up (${err.message}). The release itself is fine.`)
}

// 4. Push the commit and tag.
step('Pushing to origin')
run(`git push origin ${branch}`)
run(`git push origin ${tag}`)

console.log(`\n✓ Night Shift ${version} is released. Installed apps pick it up within 6 hours, or on their next launch.\n`)
