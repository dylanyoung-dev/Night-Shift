#!/usr/bin/env node
// A small Cloudflare R2 client (R2's S3-compatible API, signed with SigV4) using only Node, so
// releasing needs nothing but a Cloudflare R2 API token. No other tools or accounts.
//
// Credentials come from .env in the repo root (git-ignored) or your environment variables:
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
//
// Also a command line for day-to-day jobs (docs/cloudflare-runbook.md):
//   npm run r2 -- check              test the token, bucket and public URL
//   npm run r2 -- list               list releases in the bucket
//   npm run r2 -- rollback 0.1.4     point latest.yml back at an earlier release
//   npm run r2 -- link 0.1.4         point the download link at a release
import { createHash, createHmac } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const BUCKET = 'nightshift-desktop-updates'
export const PUBLIC_URL = 'https://nightshift-updates.dylanyoung.dev'
export const DOWNLOAD_KEY = 'download/NightShiftSetup.exe'

const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const hmac = (key, data) => createHmac('sha256', key).update(data).digest()
// RFC 3986 encoding, as SigV4 wants; '/' kept between key segments.
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
export const encodeKey = (key) => key.split('/').map(enc).join('/')

// SigV4 signature for one request. Exported so it can be checked against AWS's published example.
export function sign({ method, host, path, query = {}, headers = {}, region, accessKeyId, secretAccessKey, date = new Date() }) {
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const day = amzDate.slice(0, 8)
  const all = { ...headers, host, 'x-amz-date': amzDate }
  if (!all['x-amz-content-sha256']) all['x-amz-content-sha256'] = 'UNSIGNED-PAYLOAD'
  const names = Object.keys(all).map((k) => k.toLowerCase()).sort()
  const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v).trim()]))
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${enc(k)}=${enc(query[k])}`)
    .join('&')
  const canonical = [method, path, canonicalQuery, names.map((n) => `${n}:${lower[n]}\n`).join(''), names.join(';'), lower['x-amz-content-sha256']].join('\n')
  const scope = `${day}/${region}/s3/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n')
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), 's3'), 'aws4_request')
  const signature = createHmac('sha256', key).update(toSign).digest('hex')
  return {
    signature,
    headers: { ...all, authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` }
  }
}

// .env in the repo root (git-ignored) is read if present; real environment variables win.
const envFile = fileURLToPath(new URL('../.env', import.meta.url))
if (existsSync(envFile)) {
  const before = { ...process.env }
  process.loadEnvFile(envFile)
  Object.assign(process.env, before)
}

export function credentials() {
  const accountId = process.env.R2_ACCOUNT_ID
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
  const missing = [!accountId && 'R2_ACCOUNT_ID', !accessKeyId && 'R2_ACCESS_KEY_ID', !secretAccessKey && 'R2_SECRET_ACCESS_KEY'].filter(Boolean)
  if (missing.length) {
    throw new Error(`Missing ${missing.join(', ')}. Put them in .env in the repo root (docs/cloudflare-runbook.md, step 5).`)
  }
  return { accountId, accessKeyId, secretAccessKey }
}

export function r2(creds = credentials()) {
  const host = `${creds.accountId}.r2.cloudflarestorage.com`
  async function request(method, key, { query = {}, headers = {}, body } = {}) {
    const path = `/${BUCKET}${key ? '/' + encodeKey(key) : ''}`
    const signed = sign({ method, host, path, query, headers, region: 'auto', ...creds })
    const qs = Object.keys(query).length ? '?' + new URLSearchParams(query).toString() : ''
    const res = await fetch(`https://${host}${path}${qs}`, { method, headers: signed.headers, body })
    if (!res.ok && !(method === 'DELETE' && res.status === 404)) {
      const text = await res.text().catch(() => '')
      const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1]
      const msg = /<Message>([^<]+)<\/Message>/.exec(text)?.[1]
      throw new Error(`R2 ${method} ${key || BUCKET}: ${res.status} ${code ?? res.statusText}${msg ? ` (${msg})` : ''}`)
    }
    return res
  }
  return {
    async checkBucket() {
      await request('HEAD', '')
    },
    async put(key, file, { contentType = 'application/octet-stream', disposition } = {}) {
      const body = typeof file === 'string' ? readFileSync(file) : file
      const headers = { 'content-type': contentType, 'content-length': String(body.length) }
      if (disposition) headers['content-disposition'] = disposition
      await request('PUT', key, { headers, body })
    },
    async copy(from, to, { contentType = 'application/octet-stream', disposition } = {}) {
      const headers = {
        'x-amz-copy-source': `/${BUCKET}/${encodeKey(from)}`,
        'x-amz-metadata-directive': 'REPLACE',
        'content-type': contentType
      }
      if (disposition) headers['content-disposition'] = disposition
      await request('PUT', to, { headers })
    },
    async remove(key) {
      await request('DELETE', key)
    },
    async list() {
      const keys = []
      let token
      do {
        const query = { 'list-type': '2', ...(token ? { 'continuation-token': token } : {}) }
        const xml = await (await request('GET', '', { query })).text()
        const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
        for (const m of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) keys.push(unxml(m[1]))
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? unxml(/<NextContinuationToken>([^<]*)</.exec(xml)?.[1] ?? '') : undefined
      } while (token)
      return keys
    }
  }
}

// Releases in the bucket, by version: "Night Shift Setup x.y.z.exe", its blockmap, history copy.
export const versionOf = (k) =>
  /^Night Shift Setup (\d+\.\d+\.\d+)\.exe(\.blockmap)?$/.exec(k)?.[1] ?? /^history\/latest-(\d+\.\d+\.\d+)\.yml$/.exec(k)?.[1]
export const compareVersions = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number))
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}
export const installerKey = (v) => `Night Shift Setup ${v}.exe`
export const linkOptions = (v) => ({ disposition: `attachment; filename="Night Shift Setup ${v}.exe"` })

// ---- command line ----
async function main(cmd, arg) {
  if (!['check', 'list', 'rollback', 'link'].includes(cmd)) {
    console.log('Usage: npm run r2 -- check | list | rollback <version> | link <version>')
    return
  }
  const client = r2()
  const needVersion = () => {
    if (!/^\d+\.\d+\.\d+$/.test(arg ?? '')) throw new Error(`Give a version, e.g.  npm run r2 -- ${cmd} 0.1.4`)
    return arg
  }
  const versions = async () => {
    const keys = await client.list()
    return { keys, versions: [...new Set(keys.map(versionOf).filter(Boolean))].sort(compareVersions).reverse() }
  }
  switch (cmd) {
    case 'check': {
      await client.checkBucket()
      console.log(`✓ token works, bucket ${BUCKET} reachable`)
      const key = `ns-check-${Date.now()}.txt`
      await client.put(key, Buffer.from('night shift check'), { contentType: 'text/plain' })
      console.log('✓ upload works')
      try {
        const res = await fetch(`${PUBLIC_URL}/${key}`)
        console.log(res.ok ? `✓ ${PUBLIC_URL} serves the bucket` : `✗ ${PUBLIC_URL}/${key} returned ${res.status}. Is the custom domain connected and Active? (runbook step 2)`)
      } catch (err) {
        console.log(`✗ couldn't reach ${PUBLIC_URL}: ${err.cause?.code ?? err.message}. Check the custom domain (runbook step 2).`)
      }
      await client.remove(key)
      console.log('✓ delete works')
      try {
        const res = await fetch(`${PUBLIC_URL}/latest.yml`, { method: 'HEAD' })
        const cache = res.headers.get('cf-cache-status')
        console.log(cache === 'BYPASS' || cache === 'DYNAMIC' ? `✓ latest.yml isn't cached (${cache})` : `! latest.yml cf-cache-status is ${cache ?? 'missing'}; check the cache rule (runbook step 3)`)
      } catch {
        // reported above
      }
      break
    }
    case 'list': {
      const { keys, versions: vs } = await versions()
      const current = keys.includes('latest.yml') ? /version:\s*(\S+)/.exec(await (await fetch(`${PUBLIC_URL}/latest.yml`)).text())?.[1] : null
      console.log(vs.length ? vs.map((v) => `  ${v}${v === current ? '   ← latest.yml' : ''}`).join('\n') : '  no releases yet')
      break
    }
    case 'rollback': {
      const v = needVersion()
      const { keys } = await versions()
      if (!keys.includes(`history/latest-${v}.yml`) || !keys.includes(installerKey(v))) throw new Error(`${v} isn't in the bucket. See  npm run r2 -- list`)
      await client.copy(`history/latest-${v}.yml`, 'latest.yml', { contentType: 'text/yaml' })
      console.log(`✓ latest.yml now points at ${v}. Copies already on a newer version stay there (docs/releasing.md, Roll back).`)
      break
    }
    case 'link': {
      const v = needVersion()
      await client.copy(installerKey(v), DOWNLOAD_KEY, linkOptions(v))
      console.log(`✓ ${PUBLIC_URL}/${DOWNLOAD_KEY} now serves ${v}`)
      break
    }
    default:
      console.log('Usage: npm run r2 -- check | list | rollback <version> | link <version>')
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv[2], process.argv[3]).catch((err) => {
    console.error(`\n✗ ${err.message}\n`)
    process.exit(1)
  })
}
