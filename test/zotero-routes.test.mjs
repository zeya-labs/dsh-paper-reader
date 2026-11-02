// test/zotero-routes.test.mjs — Zotero 同步的 HTTP 路由层（面板 ⇣Z 按钮打的那两个接口）。
//
// 与 mineru-routes.test.mjs 同一套手法：用假 ctx 抓到 host.js 注册的 /paper-reader 前缀
// handler，再用真实 http server 承载，于是真的发 HTTP 请求。
// 只 import dist/*.js（Node 22 不能直接跑 TS）；跑前先 `npm run build`。
//
// 覆盖：GET /api/zotero/status（可用/关闭两种）、POST /api/zotero/sync（首次新增 → 幂等 skip）、
//       config.zotero.enabled=false 时的 409 zotero-disabled，以及响应体形状（counts/topics）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const dist = (m) => join(ROOT, '..', 'dist', m)

// 必须在 registerRoutes 之前把 DSH_HOME 指到临时目录（它会写 preset）
const HOME = mkdtempSync(join(tmpdir(), 'dpr-zroutes-home-'))
process.env.DSH_HOME = HOME

const { registerRoutes } = await import(pathToFileURL(dist('host.js')).href)

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2048, 0x20)])

/** 假 Zotero 本地 API：一个合集 + 一条带 PDF 的条目。 */
async function startFakeZotero() {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    res.setHeader('content-type', 'application/json')
    if (url.pathname === '/api/users/0/collections') {
      res.end(JSON.stringify([{ key: 'COL1', data: { name: '世界模型' } }]))
      return
    }
    if (url.pathname === '/api/users/0/items') {
      res.end(JSON.stringify([
        { key: 'ITEM1', data: { itemType: 'preprint', title: 'Route Fixture', collections: ['COL1'], extra: 'Citation Key: fixture2026' } },
        { key: 'ATT1', data: { itemType: 'attachment', parentItem: 'ITEM1', path: 'storage:fixture.pdf', contentType: 'application/pdf' } },
      ]))
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    apiBase: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r(undefined)) }),
  }
}

/** 起一个挂着 host 路由的 http server，返回 api 助手。 */
async function bootRoutes(config) {
  let spec = null
  const ctx = {
    webServer: { register: (s) => { spec = s; return () => {} } },
    connection: { requestRejection: () => undefined },
    sessionController: {},
    workspaceController: {},
    workspaceRegistry: {},
    effect: (fn) => fn(),
  }
  registerRoutes(ctx, config)
  assert.equal(spec.path, '/paper-reader')
  const server = createServer((req, res) => spec.handler(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${server.address().port}`
  const api = async (path, opts) => {
    const r = await fetch(`${origin}/paper-reader${path}`, opts)
    const text = await r.text()
    let body = null
    try { body = JSON.parse(text) } catch { /* 非 JSON */ }
    return { status: r.status, body, text }
  }
  return {
    api,
    post: (path, obj) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) }),
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r(undefined)) }),
  }
}

test('路由：status 报告可用 → sync 首次新增 → 再点幂等', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dpr-zroutes-data-'))
  const zoteroDir = mkdtempSync(join(tmpdir(), 'dpr-zroutes-zot-'))
  await writeFile(join(zoteroDir, 'zotero.sqlite'), '')
  await mkdir(join(zoteroDir, 'storage', 'ATT1'), { recursive: true })
  await writeFile(join(zoteroDir, 'storage', 'ATT1', 'fixture.pdf'), PDF)

  const fake = await startFakeZotero()
  const routes = await bootRoutes({ dataDir, zotero: { apiBase: fake.apiBase, dataDir: zoteroDir, mode: 'copy' } })
  try {
    const st = await routes.api('/api/zotero/status')
    assert.equal(st.status, 200)
    assert.equal(st.body.available, true)
    assert.equal(st.body.source, 'api')

    const first = await routes.post('/api/zotero/sync', {})
    assert.equal(first.status, 200)
    assert.equal(first.body.ok, true)
    assert.deepEqual(first.body.counts, { created: 1, updated: 0, skipped: 0, duplicates: 0, pruned: 0 })
    assert.deepEqual(first.body.topics, ['世界模型'])
    assert.ok(existsSync(join(dataDir, '世界模型', 'fixture.pdf')))

    const second = await routes.post('/api/zotero/sync', {})
    assert.equal(second.status, 200)
    assert.equal(second.body.counts.created, 0)
    assert.equal(second.body.counts.skipped, 1)

    // dryRun 只报告不写盘
    const dry = await routes.post('/api/zotero/sync', { dryRun: true })
    assert.equal(dry.status, 200)
    assert.equal(dry.body.counts.skipped, 1)
  } finally {
    await routes.close()
    await fake.close()
  }
})

test('路由：config.zotero.enabled=false → status 不可用、sync 409 zotero-disabled', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dpr-zroutes-data2-'))
  const routes = await bootRoutes({ dataDir, zotero: { enabled: false } })
  try {
    const st = await routes.api('/api/zotero/status')
    assert.equal(st.status, 200)
    assert.equal(st.body.enabled, false)
    assert.equal(st.body.available, false)

    const sync = await routes.post('/api/zotero/sync', {})
    assert.equal(sync.status, 409)
    assert.equal(sync.body.code, 'zotero-disabled')
    // 文案要能指导用户，不是一句「内部错误」
    assert.ok(/关闭/.test(sync.body.error), sync.body.error)
  } finally {
    await routes.close()
  }
})

test('路由：畸形 body 不炸（按空对象处理）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dpr-zroutes-data3-'))
  const routes = await bootRoutes({ dataDir, zotero: { enabled: false } })
  try {
    const r = await routes.api('/api/zotero/sync', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not-json',
    })
    assert.equal(r.status, 409)
    assert.equal(r.body.code, 'zotero-disabled')
  } finally {
    await routes.close()
  }
})
