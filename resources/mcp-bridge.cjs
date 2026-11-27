'use strict'
// Night Shift's MCP bridge for Claude Desktop. Claude Desktop starts this (with Night Shift's own exe
// and ELECTRON_RUN_AS_NODE=1, so no separate Node is needed) and talks MCP over stdio. Each message is
// passed to the running Night Shift app's local-only endpoint (see src/main/mcpServer.ts), found
// through mcp.json in Night Shift's data folder. Runs are read-only; actions can be read and saved.
//
// Usage: <Night Shift.exe> mcp-bridge.cjs <Night Shift data folder>

const fs = require('fs')
const http = require('http')
const path = require('path')
const readline = require('readline')

const dataDir = process.argv[2] || path.join(process.env.APPDATA || '', 'night-shift')
const NOT_RUNNING = "Night Shift isn't running. Open it (and check Settings → Claude Desktop is on), then try again."

function info() {
  try {
    const i = JSON.parse(fs.readFileSync(path.join(dataDir, 'mcp.json'), 'utf8'))
    return i && i.port && i.token ? i : null
  } catch {
    return null
  }
}
// The tool list from the last time the app ran, so Claude Desktop knows the tools even when the app is closed.
function savedTools() {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'mcp-tools.json'), 'utf8')).tools || []
  } catch {
    return []
  }
}

function post(i, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: i.port, path: '/mcp', method: 'POST', timeout: 60000, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${i.token}`, 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (data += c))
        res.on('end', () => resolve({ status: res.statusCode, data }))
      }
    )
    req.on('timeout', () => req.destroy(new Error('Night Shift took too long to answer.')))
    req.on('error', reject)
    req.end(body)
  })
}

const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')

// Answers for when the app can't be reached.
function offline(msg, why) {
  if (msg.id === undefined) return
  if (msg.method === 'initialize')
    return out({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'night-shift', version: 'offline' } } })
  if (msg.method === 'ping') return out({ jsonrpc: '2.0', id: msg.id, result: {} })
  if (msg.method === 'tools/list') return out({ jsonrpc: '2.0', id: msg.id, result: { tools: savedTools() } })
  if (msg.method === 'tools/call') return out({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: why }], isError: true } })
  out({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: why } })
}

async function handle(line) {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
  }
  const i = info()
  if (!i) return offline(msg, NOT_RUNNING)
  try {
    const r = await post(i, line)
    if (msg.id === undefined) return
    if (r.status === 200 && r.data) return process.stdout.write(r.data.trim() + '\n')
    offline(msg, r.status === 401 ? 'Night Shift refused the bridge (it may have just restarted). Try again.' : `Night Shift answered ${r.status}.`)
  } catch (err) {
    offline(msg, err && err.code === 'ECONNREFUSED' ? NOT_RUNNING : `Couldn't reach Night Shift: ${err && err.message}`)
  }
}

// When Night Shift starts with a different tool list (an update added tools), tell the client to
// fetch the list again, so it doesn't keep the one it got when it connected.
let toolsSeen = JSON.stringify(savedTools())
fs.watchFile(path.join(dataDir, 'mcp-tools.json'), { interval: 5000 }, () => {
  const now = JSON.stringify(savedTools())
  if (now === toolsSeen) return
  toolsSeen = now
  out({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
})
process.stdin.on('end', () => process.exit(0))

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim()) handle(line).catch((err) => process.stderr.write(`night-shift bridge: ${err && err.message}\n`))
})
