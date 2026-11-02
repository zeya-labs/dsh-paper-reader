// zotero-sync.test.mjs — Zotero → 文献库同步（src/zotero.ts）的契约测试。
//
// 不依赖真实 Zotero：这里起一个假的本机 API 服务（与 Zotero 本地 API 同形状），
// 配一个临时「Zotero 数据目录」放 storage/<key>/<file>.pdf，验证：
//   ① 快照解析（顶层条目 / 附件 / 合集 / 忽略 HTML 快照与笔记）
//   ② 落盘（专题映射、命名、硬链接或复制）
//   ③ 幂等（第二次全 skip）
//   ④ 同内容去重（用户手动上传过的同一篇不会变成两份）
//   ⑤ 改名/换 PDF 后更新 + 失效转录缓存
//   ⑥ 孤儿 prune（移入 .zotero-sync/trash，不硬删）
//   ⑦ 名字安全（Zotero 里的 `../` 不能越出库根）
//   ⑧ 状态探测（关闭 / 无 Zotero / sqlite 回落）
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import {
  ZOTERO_DEFAULTS,
  attachmentFile,
  attachmentFilename,
  citationKeyFrom,
  detectZoteroDataDir,
  isPdfAttachment,
  loadSqlite,
  readSqliteSnapshot,
  sanitizeName,
  syncFromZotero,
  topicNamesFor,
  zoteroStatus,
} from '../dist/zotero.js'

const PDF_BYTES = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2048, 0x20)])
const PDF_BYTES_2 = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(3000, 0x41)])

/** 假 Zotero 本地 API：/api/users/0/collections 与 /api/users/0/items（带 limit/start 分页）。 */
async function startFakeZotero({ items, collections, pageLimit = 100 }) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/api/users/0/collections') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(collections))
      return
    }
    if (url.pathname === '/api/users/0/items') {
      const start = Number(url.searchParams.get('start') ?? 0)
      const limit = Math.min(Number(url.searchParams.get('limit') ?? pageLimit), pageLimit)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(items.slice(start, start + limit)))
      return
    }
    res.writeHead(404)
    res.end('nope')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  return {
    apiBase: `http://127.0.0.1:${port}`,
    // undici 默认 keep-alive，不断开连接 server.close() 会一直等 → 测试挂死
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.()
        server.close(() => r(undefined))
      }),
  }
}

/** 在临时 Zotero 数据目录里放一份附件文件，返回它的 items 条目 JSON。 */
async function seedAttachment(zoteroDir, attKey, filename, bytes = PDF_BYTES) {
  const dir = join(zoteroDir, 'storage', attKey)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, filename), bytes)
  return { dir, file: join(dir, filename) }
}

function apiItem(key, data) {
  return { key, version: 1, data }
}

/** 一套完整的假库：一个合集、一个带 PDF 的条目。 */
async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dpr-zotero-test-'))
  const zoteroDir = join(root, 'Zotero')
  const dataDir = join(root, 'library')
  await mkdir(zoteroDir, { recursive: true })
  await mkdir(dataDir, { recursive: true })
  // 数据目录探测要求 zotero.sqlite 存在，否则会回落到开发机真实的 ~/Zotero
  await writeFile(join(zoteroDir, 'zotero.sqlite'), '')
  await seedAttachment(zoteroDir, 'ATT1', 'Lu et al. - 2026 - Track4World.pdf')
  const collections = [{ key: 'COL1', data: { name: '世界模型' } }]
  const items = [
    apiItem('ITEM1', {
      itemType: 'preprint',
      title: 'Track4World: Feedforward World-centric Dense 3D Tracking of All Pixels',
      date: '2026-03-05',
      collections: ['COL1'],
      extra: 'Citation Key: lu2026track4world',
    }),
    apiItem('ATT1', {
      itemType: 'attachment',
      parentItem: 'ITEM1',
      path: 'storage:Lu et al. - 2026 - Track4World.pdf',
      filename: 'Lu et al. - 2026 - Track4World.pdf',
      contentType: 'application/pdf',
    }),
    // HTML 快照必须被忽略
    apiItem('ATT2', { itemType: 'attachment', parentItem: 'ITEM1', path: 'storage:2603.html', contentType: 'text/html' }),
    // 笔记必须被忽略
    apiItem('NOTE1', { itemType: 'note', parentItem: 'ITEM1', note: '<p>hi</p>' }),
    // 没有 PDF 的条目：跳过
    apiItem('ITEM2', { itemType: 'journalArticle', title: 'No PDF here', collections: ['COL1'] }),
  ]
  return { root, zoteroDir, dataDir, collections, items }
}

test('纯函数：命名、附件路径、Citation Key', async (t) => {
  await t.test('sanitizeName 挡掉 Windows 非法字符与穿越', () => {
    assert.equal(sanitizeName('a/b\\c:d*e?f"g<h>i|j'), 'a-b-c-d-e-f-g-h-i-j')
    assert.equal(sanitizeName('../../etc/passwd'), '..-..-etc-passwd')
    assert.equal(sanitizeName('trailing dots... '), 'trailing dots')
    assert.equal(sanitizeName('   '), 'untitled')
    assert.equal(sanitizeName('CON'), '_CON')
    // 长度上限：截断后不留尾点/空格
    assert.ok(sanitizeName('x'.repeat(200), 20).length <= 20)
  })

  await t.test('attachmentFilename / attachmentFile', () => {
    const att = { key: 'K1', path: 'storage:foo bar.pdf' }
    assert.equal(attachmentFilename(att), 'foo bar.pdf')
    assert.equal(attachmentFile('C:\\Zotero', att), join('C:\\Zotero', 'storage', 'K1', 'foo bar.pdf'))
    // 绝对路径的链接式附件原样返回
    assert.equal(attachmentFile('C:\\Zotero', { key: 'K2', path: 'D:\\papers\\x.pdf' }), 'D:\\papers\\x.pdf')
    // 什么都没有 → null（不猜）
    assert.equal(attachmentFile('C:\\Zotero', { key: 'K3' }), null)
  })

  await t.test('isPdfAttachment 只认 PDF', () => {
    assert.equal(isPdfAttachment({ key: 'a', path: 'storage:x.pdf' }), true)
    assert.equal(isPdfAttachment({ key: 'b', path: 'storage:x.html', contentType: 'text/html' }), false)
    assert.equal(isPdfAttachment({ key: 'c', contentType: 'application/pdf' }), true)
  })

  await t.test('citationKeyFrom 从 Extra 里挖', () => {
    assert.equal(citationKeyFrom('Citation Key: lu2026\nfoo'), 'lu2026')
    assert.equal(citationKeyFrom('foo: bar'), undefined)
    assert.equal(citationKeyFrom(undefined), undefined)
  })

  await t.test('topicNamesFor：叶子名，重名退化全路径', () => {
    const map = topicNamesFor([
      { id: 'A', name: '世界模型', parentId: null },
      { id: 'B', name: '3D Tracking', parentId: 'A' },
      { id: 'C', name: 'Survey', parentId: null },
      { id: 'D', name: 'Survey', parentId: 'A' },
    ])
    assert.equal(map.get('A'), '世界模型')
    assert.equal(map.get('B'), '3D Tracking')
    // 两处都叫 Survey → 用完整路径区分
    assert.equal(map.get('C'), 'Survey')
    assert.equal(map.get('D'), '世界模型 - Survey')
  })
})

test('API 快照：解析条目/附件，忽略 HTML 与笔记', async () => {
  const fx = await makeFixture()
  const fake = await startFakeZotero({ items: fx.items, collections: fx.collections, pageLimit: 2 })
  try {
    const { readApiSnapshot } = await import('../dist/zotero.js')
    const snap = await readApiSnapshot({ apiBase: fake.apiBase, zoteroDataDir: fx.zoteroDir, pageSize: 2 })
    assert.equal(snap.source, 'api')
    const item = snap.items.find((i) => i.key === 'ITEM1')
    assert.ok(item, '顶层条目应在快照里')
    assert.equal(item.attachments.length, 1, '只有 PDF 附件，HTML 快照被忽略')
    assert.equal(item.attachments[0].key, 'ATT1')
    assert.deepEqual(item.collectionIds, ['COL1'])
    assert.equal(item.citationKey, 'lu2026track4world')
    assert.equal(snap.items.find((i) => i.key === 'NOTE1'), undefined, '笔记不是条目')
    assert.equal(snap.collections.length, 1)
  } finally {
    await fake.close()
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('同步：新增 → 幂等 → 同内容去重 → 更新', async () => {
  const fx = await makeFixture()
  const fake = await startFakeZotero({ items: fx.items, collections: fx.collections })
  try {
    const base = { dataDir: fx.dataDir, zotero: { apiBase: fake.apiBase, dataDir: fx.zoteroDir, mode: 'copy' } }

    // ① 首次同步
    const first = await syncFromZotero(base)
    assert.equal(first.counts.created, 1)
    assert.equal(first.counts.updated, 0)
    const target = join(fx.dataDir, '世界模型', 'Lu et al. - 2026 - Track4World.pdf')
    assert.ok(existsSync(target), 'PDF 应落到专题目录里')
    assert.deepEqual(await readFile(target), PDF_BYTES)
    assert.deepEqual(first.topics, ['世界模型'])
    // manifest 落盘
    const manifest = JSON.parse(await readFile(join(fx.dataDir, '.zotero-sync', 'manifest.json'), 'utf8'))
    assert.ok(manifest.attachments.ATT1, '按附件 key 记账')
    assert.equal(manifest.attachments.ATT1.itemKey, 'ITEM1')

    // ② 幂等
    const second = await syncFromZotero(base)
    assert.equal(second.counts.created, 0)
    assert.equal(second.counts.updated, 0)
    assert.equal(second.counts.skipped, 1)

    // ③ 用户手动上传过同一篇（内容相同、名字不同）→ 不重复入库
    await writeFile(join(fx.dataDir, '世界模型', '手工上传的另一份.pdf'), PDF_BYTES)
    const fresh = await rm(join(fx.dataDir, '世界模型', 'Lu et al. - 2026 - Track4World.pdf'))
    assert.equal(fresh, undefined)
    const third = await syncFromZotero(base)
    assert.equal(third.counts.created, 0)
    assert.equal(third.counts.duplicates, 1)
    assert.equal(third.duplicates[0].sameAs, '世界模型/手工上传的另一份')
    assert.ok(!existsSync(target), '同内容时不应再落一份')

    // ④ 内容变了 → 更新，并清掉转录缓存（插件按 .txt 大小判缓存，不看 mtime）
    await writeFile(join(fx.zoteroDir, 'storage', 'ATT1', 'Lu et al. - 2026 - Track4World.pdf'), PDF_BYTES_2)
    await writeFile(join(fx.dataDir, '世界模型', 'stale-cache.txt'), 'x'.repeat(2000))
    await writeFile(target, PDF_BYTES_2) // 让目标已存在，模拟上一轮
    const upd = await syncFromZotero(base)
    assert.equal(upd.counts.skipped, 1, '内容一致（上一轮已写入）→ skip')
  } finally {
    await fake.close()
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('同步：内容变化时更新并失效转录缓存', async () => {
  const fx = await makeFixture()
  const fake = await startFakeZotero({ items: fx.items, collections: fx.collections })
  try {
    const base = { dataDir: fx.dataDir, zotero: { apiBase: fake.apiBase, dataDir: fx.zoteroDir, mode: 'copy' } }
    await syncFromZotero(base)
    const target = join(fx.dataDir, '世界模型', 'Lu et al. - 2026 - Track4World.pdf')
    assert.deepEqual(await readFile(target), PDF_BYTES)

    // 换掉 Zotero 里的 PDF，并在库里放一份旧转录缓存
    const src = join(fx.zoteroDir, 'storage', 'ATT1', 'Lu et al. - 2026 - Track4World.pdf')
    await writeFile(src, PDF_BYTES_2)
    const audio = join(fx.dataDir, '世界模型', 'Lu et al. - 2026 - Track4World.txt')
    await writeFile(audio, 'old transcript '.repeat(100))
    assert.ok(existsSync(audio))

    const upd = await syncFromZotero(base)
    assert.equal(upd.counts.updated, 1)
    assert.deepEqual(await readFile(target), PDF_BYTES_2, '目标内容应被替换')
    assert.ok(!existsSync(audio), '旧转录缓存必须被删（否则 search 会读到旧文本）')
  } finally {
    await fake.close()
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('同步：命名模式（citekey / key）与多合集', async () => {
  const fx = await makeFixture()
  const collections = [...fx.collections, { key: 'COL2', data: { name: 'Agentic Embodied AI' } }]
  const items = fx.items.map((it) =>
    it.key === 'ITEM1' ? { ...it, data: { ...it.data, collections: ['COL1', 'COL2'] } } : it)
  const fake = await startFakeZotero({ items, collections })
  try {
    const out = await syncFromZotero({
      dataDir: fx.dataDir,
      zotero: { apiBase: fake.apiBase, dataDir: fx.zoteroDir, mode: 'copy', nameMode: 'citekey', multi: true },
    })
    assert.equal(out.counts.created, 2, 'multi=true 时两个专题各一份')
    assert.ok(existsSync(join(fx.dataDir, '世界模型', 'lu2026track4world - Lu et al. - 2026 - Track4World.pdf')))
    assert.ok(existsSync(join(fx.dataDir, 'Agentic Embodied AI', 'lu2026track4world - Lu et al. - 2026 - Track4World.pdf')))
  } finally {
    await fake.close()
    await rm(fx.root, { recursive: true, force: true })
  }

  const fx2 = await makeFixture()
  const fake2 = await startFakeZotero({ items: fx2.items, collections: fx2.collections })
  try {
    const out = await syncFromZotero({
      dataDir: fx2.dataDir,
      zotero: { apiBase: fake2.apiBase, dataDir: fx2.zoteroDir, mode: 'copy', nameMode: 'key' },
    })
    assert.equal(out.counts.created, 1)
    assert.ok(existsSync(join(fx2.dataDir, '世界模型', 'ITEM1.pdf')), 'key 模式用条目 key 命名')
  } finally {
    await fake2.close()
    await rm(fx2.root, { recursive: true, force: true })
  }
})

test('同步：无名合集条目落到未分类；同名冲突追加条目 key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dpr-zotero-test-'))
  const zoteroDir = join(root, 'Zotero')
  const dataDir = join(root, 'library')
  await mkdir(zoteroDir, { recursive: true })
  await writeFile(join(zoteroDir, 'zotero.sqlite'), '')
  await seedAttachment(zoteroDir, 'A1', 'paper.pdf')
  await seedAttachment(zoteroDir, 'A2', 'paper.pdf', PDF_BYTES_2)
  const items = [
    apiItem('I1', { itemType: 'preprint', title: 'Same Name One' }),
    apiItem('A1', { itemType: 'attachment', parentItem: 'I1', path: 'storage:paper.pdf', contentType: 'application/pdf' }),
    apiItem('I2', { itemType: 'preprint', title: 'Same Name Two' }),
    apiItem('A2', { itemType: 'attachment', parentItem: 'I2', path: 'storage:paper.pdf', contentType: 'application/pdf' }),
  ]
  const fake = await startFakeZotero({ items, collections: [] })
  try {
    const out = await syncFromZotero({
      dataDir,
      zotero: { apiBase: fake.apiBase, dataDir: zoteroDir, mode: 'copy', unfiled: '未分类' },
    })
    assert.equal(out.counts.created, 2)
    assert.ok(existsSync(join(dataDir, '未分类', 'paper.pdf')))
    assert.ok(existsSync(join(dataDir, '未分类', 'paper (I2).pdf')), '同名冲突要追加条目 key')
  } finally {
    await fake.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('同步：孤儿报告 / prune 移入回收目录（不硬删）', async () => {
  const fx = await makeFixture()
  const fake = await startFakeZotero({ items: fx.items, collections: fx.collections })
  const base = { dataDir: fx.dataDir, zotero: { apiBase: fake.apiBase, dataDir: fx.zoteroDir, mode: 'copy' } }
  try {
    await syncFromZotero(base)
    const target = join(fx.dataDir, '世界模型', 'Lu et al. - 2026 - Track4World.pdf')
    assert.ok(existsSync(target))

    // Zotero 里该条目没了 → 只报告
    await fake.close()
    const empty = await startFakeZotero({ items: [], collections: [] })
    try {
      const reported = await syncFromZotero({ ...base, zotero: { ...base.zotero, apiBase: empty.apiBase } })
      assert.equal(reported.counts.pruned, 1)
      assert.ok(existsSync(target), '默认不删文件')
      assert.ok(reported.warnings.some((w) => w.includes('Zotero')), '要给出提示')

      const pruned = await syncFromZotero(
        { ...base, zotero: { ...base.zotero, apiBase: empty.apiBase }, prune: true },
      )
      assert.equal(pruned.counts.pruned, 1)
      assert.ok(!existsSync(target), 'prune 后从库里移走')
      const trashDir = join(fx.dataDir, '.zotero-sync', 'trash')
      assert.ok(existsSync(trashDir), '要进回收目录而不是删除')
    } finally {
      await empty.close()
    }
  } finally {
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('安全：Zotero 里的 ../ 名字不能越出库根', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dpr-zotero-test-'))
  const zoteroDir = join(root, 'Zotero')
  const dataDir = join(root, 'library')
  await mkdir(zoteroDir, { recursive: true })
  await writeFile(join(zoteroDir, 'zotero.sqlite'), '')
  await seedAttachment(zoteroDir, 'A1', '../evil.pdf')
  const collections = [{ key: 'C1', data: { name: '../../outside' } }]
  const items = [
    apiItem('I1', { itemType: 'preprint', title: 'evil', collections: ['C1'] }),
    apiItem('A1', { itemType: 'attachment', parentItem: 'I1', path: 'storage:../evil.pdf', contentType: 'application/pdf' }),
  ]
  const fake = await startFakeZotero({ items, collections })
  try {
    const out = await syncFromZotero({
      dataDir,
      zotero: { apiBase: fake.apiBase, dataDir: zoteroDir, mode: 'copy' },
    })
    // 专题名与文件名都被净化：不含路径分隔符，落盘路径仍在 dataDir 内
    assert.equal(out.counts.created, 1)
    const topic = out.topics[0]
    assert.ok(topic && !/[/\\]/.test(topic), `专题名不应含路径分隔符：${topic}`)
    const landed = join(dataDir, topic)
    assert.ok(existsSync(landed))
    // 净化后的名字里的 ".." 只是字面量（没有分隔符就构不成穿越），真正的不变量是落在库内
    assert.ok(resolve(landed).startsWith(resolve(dataDir) + sep) || resolve(landed) === resolve(dataDir))
    assert.ok(!existsSync(join(root, 'outside')), '不能写到库根之外')
    assert.ok(!existsSync(join(root, 'evil.pdf')), '不能写到库根之外')
  } finally {
    await fake.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('状态探测：disabled / 连不上 / 数据目录探测', async () => {
  const off = await zoteroStatus({ zotero: { enabled: false } })
  assert.equal(off.available, false)
  assert.equal(off.reason, 'disabled')

  // 用空的 home 隔离开发机上的真实 ~/Zotero，结果才确定
  const emptyHome = await mkdtemp(join(tmpdir(), 'dpr-empty-home-'))
  try {
    const dead = await zoteroStatus({
      zotero: { apiBase: 'http://127.0.0.1:1' },
      home: emptyHome,
    })
    assert.equal(dead.available, false)
    assert.equal(dead.reason, 'no-zotero-data-dir')
  } finally {
    await rm(emptyHome, { recursive: true, force: true })
  }

  const root = await mkdtemp(join(tmpdir(), 'dpr-zotero-status-'))
  await writeFile(join(root, 'zotero.sqlite'), '')
  try {
    assert.equal(detectZoteroDataDir(root), root)
    // 数据目录在、API 不可达 → 走 sqlite（node:sqlite 可用时）
    const sqlite = await loadSqlite()
    const st = await zoteroStatus({ zotero: { apiBase: 'http://127.0.0.1:1', dataDir: root }, home: root })
    if (sqlite) {
      assert.equal(st.available, true)
      assert.equal(st.source, 'sqlite')
    } else {
      assert.equal(st.available, false)
      assert.equal(st.reason, 'sqlite-unavailable')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('sqlite 来源：只读快照能解析合集/条目/附件', async (t) => {
  const sqlite = await loadSqlite()
  if (!sqlite) {
    t.skip('当前 Node 没有 node:sqlite（<22.5 或未启用），跳过 sqlite 来源测试')
    return
  }
  const { DatabaseSync } = sqlite
  const root = await mkdtemp(join(tmpdir(), 'dpr-zotero-sqlite-'))
  const zoteroDir = join(root, 'Zotero')
  await mkdir(zoteroDir, { recursive: true })
  await seedAttachment(zoteroDir, 'ATT9', 'Sheng et al. - 2026 - Ask to Evolve.pdf')
  const db = new DatabaseSync(join(zoteroDir, 'zotero.sqlite'))
  db.exec(`
    CREATE TABLE itemTypes (itemTypeID INTEGER PRIMARY KEY, typeName TEXT);
    CREATE TABLE items (itemID INTEGER PRIMARY KEY, itemTypeID INTEGER, key TEXT);
    CREATE TABLE fields (fieldID INTEGER PRIMARY KEY, fieldName TEXT);
    CREATE TABLE itemDataValues (valueID INTEGER PRIMARY KEY, value TEXT);
    CREATE TABLE itemData (itemID INTEGER, fieldID INTEGER, valueID INTEGER);
    CREATE TABLE collections (collectionID INTEGER PRIMARY KEY, collectionName TEXT, parentCollectionID INTEGER, key TEXT);
    CREATE TABLE collectionItems (collectionID INTEGER, itemID INTEGER);
    CREATE TABLE itemAttachments (itemID INTEGER PRIMARY KEY, parentItemID INTEGER, linkMode INTEGER, contentType TEXT, path TEXT);
    CREATE TABLE itemNotes (itemID INTEGER PRIMARY KEY, parentItemID INTEGER, note TEXT);
    CREATE TABLE itemAnnotations (itemID INTEGER PRIMARY KEY, parentItemID INTEGER);
    CREATE TABLE deletedItems (itemID INTEGER PRIMARY KEY);
  `)
  db.exec(`
    INSERT INTO itemTypes VALUES (1,'preprint'),(2,'attachment'),(3,'note');
    INSERT INTO collections VALUES (5,'Agentic Embodied AI',NULL,'COL5');
    INSERT INTO items VALUES (1,1,'ITEM9'),(2,2,'ATT9'),(3,3,'NOTE9');
    INSERT INTO itemAttachments VALUES (2,1,0,'application/pdf','storage:Sheng et al. - 2026 - Ask to Evolve.pdf');
    INSERT INTO itemNotes VALUES (3,1,'<p>note</p>');
    INSERT INTO collectionItems VALUES (5,1);
    INSERT INTO fields VALUES (11,'title'),(12,'date'),(13,'citationKey');
    INSERT INTO itemDataValues VALUES (101,'Ask to Evolve: A Unified Harness'),(102,'2026-10-29'),(103,'sheng2026ask');
    INSERT INTO itemData VALUES (1,11,101),(1,12,102),(1,13,103);
  `)
  db.close()
  try {
    const snap = await readSqliteSnapshot({ zoteroDataDir: zoteroDir, sqlite })
    assert.equal(snap.source, 'sqlite')
    const item = snap.items.find((i) => i.key === 'ITEM9')
    assert.ok(item, '顶层条目应被解析')
    assert.equal(item.title, 'Ask to Evolve: A Unified Harness')
    assert.equal(item.citationKey, 'sheng2026ask')
    assert.deepEqual(item.collectionIds, ['5'])
    assert.equal(item.attachments.length, 1)
    assert.equal(item.attachments[0].key, 'ATT9')
    assert.equal(snap.items.find((i) => i.key === 'NOTE9'), undefined)
    assert.equal(snap.collections[0].name, 'Agentic Embodied AI')

    // 落盘也走同一条链路
    const dataDir = join(root, 'library')
    const out = await syncFromZotero({ dataDir, zotero: { dataDir: zoteroDir, apiBase: 'http://127.0.0.1:1', mode: 'copy' } })
    assert.equal(out.source, 'sqlite')
    assert.equal(out.counts.created, 1)
    assert.ok(existsSync(join(dataDir, 'Agentic Embodied AI', 'Sheng et al. - 2026 - Ask to Evolve.pdf')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('默认配置：启用、硬链接、stem 命名', () => {
  assert.equal(ZOTERO_DEFAULTS.enabled, true)
  assert.equal(ZOTERO_DEFAULTS.mode, 'link')
  assert.equal(ZOTERO_DEFAULTS.nameMode, 'stem')
  assert.equal(ZOTERO_DEFAULTS.apiBase, 'http://127.0.0.1:23119')
})
