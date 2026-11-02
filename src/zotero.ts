// zotero.ts — 从本机 Zotero（My Library）单向同步 PDF 进伴读文献库。
//
// 为什么需要它：文献库是**纯目录约定** `<dataDir>/<专题>/<文献>.pdf`，插件没有任何
// 「外部文献源」的概念。Zotero 用户只能一篇篇手动上传。这里给面板加一个「从 Zotero 同步」
// 按钮，把 Zotero 的合集成专题、条目的 PDF 附件成文献，落进同一个库目录。
//
// 三条硬约束（读 library.ts + 实测确认，改动前先读一遍）：
//   ① 库只扫**一级子目录里的普通文件**：根目录散落的 PDF 不算文献，必须有专题目录。
//   ② **符号链接会被忽略**：listPapers 用 readdirSync({withFileTypes}) 后判 Dirent.isFile()，
//      软链的 isFile() 是 false。硬链接是普通文件、可见，且与 Zotero 原件共享同一份数据，
//      不额外占磁盘 —— 所以默认 link（硬链接），失败才退化为复制。
//   ③ 插件不监听目录，只读盘 ⇒ 「同步」就是把这个目录刷成 Zotero 的样子。
//
// 数据来源两选一，自动探测（都不写 Zotero 的任何文件）：
//   · Zotero 本地 HTTP API（127.0.0.1:23119）——官方入口，需要用户在
//     「设置 → 高级 → 允许此计算机上的其他应用程序与 Zotero 通信」里打开；
//   · 直接只读 zotero.sqlite —— 把 db/-wal/-shm 复制到临时目录再查，不锁库。
//     Node 22.5+ 的 node:sqlite 提供同步 API；不可用时自动跳过。
//
// 本文件是纯函数 + fs 副作用的模块，不依赖 Cordis（与 library.ts 同级约定）。

import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { copyFile, link, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'

// ── 配置 ────────────────────────────────────────────────────────────────────

export interface ZoteroConfig {
  /** 置 false 可整体关闭（面板不显示同步按钮、路由返回 disabled）。默认开。 */
  enabled?: boolean
  /** Zotero 数据目录；默认自动探测 ~/Zotero 与 %APPDATA%\Zotero\Zotero。 */
  dataDir?: string
  /** Zotero 本地 API 基址；默认 http://127.0.0.1:23119。 */
  apiBase?: string
  /** link=硬链接（省空间，默认）/ copy=真实复制（跨盘或想彻底独立时用）。 */
  mode?: 'link' | 'copy'
  /** stem=附件名（默认）/ citekey=优先 Citation Key 前缀 / key=条目 key。 */
  nameMode?: 'stem' | 'citekey' | 'key'
  /** 一条文献属于多个合集时，是否在每个专题都放一份（默认只放第一个）。 */
  multi?: boolean
  /** 不属于任何合集的条目落到这个专题名。 */
  unfiled?: string
}

export const ZOTERO_DEFAULTS = {
  enabled: true,
  apiBase: 'http://127.0.0.1:23119',
  mode: 'link' as const,
  nameMode: 'stem' as const,
  multi: false,
  unfiled: '未分类',
}

/** 同步过程中的可识别错误（host 层据此给 4xx/5xx，而不是笼统 500）。 */
export class ZoteroSyncError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, status: number, message: string) {
    super(message)
    this.name = 'ZoteroSyncError'
    this.code = code
    this.status = status
  }
}

// ── 快照模型 ────────────────────────────────────────────────────────────────

export interface ZoteroCollectionRow {
  /** 合集 key（API）或 collectionID 字符串（sqlite）；只用于父子关系。 */
  id: string
  name: string
  parentId: string | null
}

export interface ZoteroAttachmentRow {
  key: string
  /** Zotero 的 path 字段：`storage:文件名` 或绝对路径。 */
  path?: string
  /** Web API 会给 filename；sqlite 从 path 里取。 */
  filename?: string
  contentType?: string
}

export interface ZoteroItemRow {
  key: string
  title: string
  date?: string
  citationKey?: string
  /** 所属合集 id 列表（按快照里的 id 空间）。 */
  collectionIds: string[]
  attachments: ZoteroAttachmentRow[]
}

export interface ZoteroSnapshot {
  source: 'api' | 'sqlite'
  zoteroDataDir: string
  collections: ZoteroCollectionRow[]
  items: ZoteroItemRow[]
}

type FetchLike = (input: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
  text(): Promise<string>
}>

// ── 纯函数：命名与路径 ──────────────────────────────────────────────────────

const BAD_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g
const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
])

/** 把 Zotero 的名字变成合法、跨平台的 Windows/Unix 文件名（并挡住路径穿越）。 */
export function sanitizeName(raw: string, limit = 110): string {
  let out = String(raw ?? '').replace(BAD_CHARS, '-').replace(/\s+/g, ' ').trim()
  out = out.replace(/[. ]+$/, '')
  if (RESERVED.has(out.toLowerCase().split('.')[0] ?? '')) out = '_' + out
  if (out.length > limit) out = out.slice(0, limit).replace(/[. ]+$/, '')
  return out || 'untitled'
}

/** 合集 → 专题名：叶子名；不同父分支下重名时退化为「父 - 子」全路径。 */
export function topicNamesFor(collections: ZoteroCollectionRow[]): Map<string, string> {
  const byId = new Map(collections.map((c) => [c.id, c]))
  const paths = new Map<string, string[]>()
  const walk = (id: string, seen: Set<string>): string[] => {
    const cached = paths.get(id)
    if (cached) return cached
    const row = byId.get(id)
    if (!row || seen.has(id)) return []
    seen.add(id)
    const parent = row.parentId ? walk(row.parentId, seen) : []
    const path = [...parent, sanitizeName(row.name, 60)]
    paths.set(id, path)
    return path
  }
  for (const c of collections) walk(c.id, new Set())
  const leafCount = new Map<string, number>()
  for (const path of paths.values()) {
    const leaf = path[path.length - 1]
    if (leaf) leafCount.set(leaf, (leafCount.get(leaf) ?? 0) + 1)
  }
  const out = new Map<string, string>()
  for (const [id, path] of paths) {
    const leaf = path[path.length - 1]
    if (!leaf) out.set(id, `collection-${sanitizeName(id, 40)}`)
    else if ((leafCount.get(leaf) ?? 0) > 1) out.set(id, path.join(' - '))
    else out.set(id, leaf)
  }
  return out
}

/** 附件文件名：path 里的 `storage:` 部分优先，其次 filename。 */
export function attachmentFilename(att: ZoteroAttachmentRow): string | null {
  const raw = att.path ?? ''
  if (raw.startsWith('storage:')) return raw.slice('storage:'.length) || null
  if (raw && /^([a-zA-Z]:[\\/]|[\\/])/.test(raw)) return basename(raw)
  return att.filename ?? null
}

/** 附件本地绝对路径；`storage:` 走 <zoteroDataDir>/storage/<附件key>/<文件名>。 */
export function attachmentFile(zoteroDataDir: string, att: ZoteroAttachmentRow): string | null {
  const raw = att.path ?? ''
  if (raw.startsWith('storage:')) {
    const name = raw.slice('storage:'.length)
    return name ? join(zoteroDataDir, 'storage', att.key, name) : null
  }
  if (raw && /^([a-zA-Z]:[\\/]|[\\/])/.test(raw)) return raw
  if (att.filename) return join(zoteroDataDir, 'storage', att.key, att.filename)
  return null
}

/** 是不是我们要的 PDF 附件（只认 PDF；HTML 快照等一律忽略）。 */
export function isPdfAttachment(att: ZoteroAttachmentRow): boolean {
  const type = (att.contentType ?? '').toLowerCase()
  if (type === 'application/pdf') return true
  if (type && type !== 'application/pdf') return false
  const name = attachmentFilename(att) ?? ''
  return name.toLowerCase().endsWith('.pdf')
}

// ── 来源一：Zotero 本地 HTTP API ────────────────────────────────────────────

interface ApiItem {
  key?: string
  data?: {
    itemType?: string
    title?: string
    date?: string
    parentItem?: string | false
    collections?: string[]
    path?: string
    filename?: string
    contentType?: string
    extra?: string
    citationKey?: string
    deleted?: boolean
  }
}

/** 从 Extra 里挖 Citation Key（Zotero 的 Better BibTeX 兼容字段）。 */
export function citationKeyFrom(extra: string | undefined): string | undefined {
  if (!extra) return undefined
  const m = /^\s*citation\s*key\s*:\s*(\S+)\s*$/im.exec(extra)
  return m?.[1]
}

async function getJson(fetchImpl: FetchLike, url: string, timeoutMs = 8000): Promise<unknown> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { signal: ac.signal, headers: { accept: 'application/json' } })
    if (!res.ok) throw new ZoteroSyncError('zotero-api-error', 502, `Zotero 本地 API 返回 HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/** 探测本地 API 是否可用（开关没开时 Zotero 会回 400 「Local API is not enabled」）。 */
export async function probeZoteroApi(
  apiBase: string,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  timeoutMs = 2000,
): Promise<boolean> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetchImpl(`${apiBase.replace(/\/$/, '')}/api/users/0/collections?limit=1`, { signal: ac.signal })
    if (!res.ok) return false
    const body = (await res.json()) as unknown
    return Array.isArray(body)
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 分页拉全库条目（含子条目）。Zotero 本地 API 的 `/items` 同时返回顶层条目与附件，
 * 且顶层条目的 `data.collections` 直接给出所属合集 key —— 一次遍历就够，不用逐条查 children。
 */
export async function readApiSnapshot(opts: {
  apiBase: string
  zoteroDataDir: string
  fetchImpl?: FetchLike
  pageSize?: number
  maxPages?: number
}): Promise<ZoteroSnapshot> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  const base = opts.apiBase.replace(/\/$/, '')
  const pageSize = opts.pageSize ?? 100
  const maxPages = opts.maxPages ?? 200

  const rawCollections = (await getJson(fetchImpl, `${base}/api/users/0/collections?format=json&limit=100`)) as
    | Array<{ key?: string; data?: { name?: string; parentCollection?: string | false } }>
    | undefined
  const collections: ZoteroCollectionRow[] = (rawCollections ?? [])
    .filter((c) => typeof c.key === 'string')
    .map((c) => ({
      id: c.key as string,
      name: c.data?.name ?? (c.key as string),
      parentId: typeof c.data?.parentCollection === 'string' ? c.data.parentCollection : null,
    }))

  const items: ZoteroItemRow[] = []
  const attachmentsByParent = new Map<string, ZoteroAttachmentRow[]>()
  const orphans: ZoteroItemRow[] = []

  for (let page = 0; page < maxPages; page++) {
    const start = page * pageSize
    const batch = (await getJson(
      fetchImpl,
      `${base}/api/users/0/items?format=json&limit=${pageSize}&start=${start}`,
    )) as ApiItem[] | undefined
    if (!Array.isArray(batch) || batch.length === 0) break
    for (const it of batch) {
      const data = it.data ?? {}
      if (typeof it.key !== 'string' || data.deleted) continue
      if (data.itemType === 'attachment') {
        if (!isPdfAttachment({ key: it.key, ...(data.path ? { path: data.path } : {}), ...(data.filename ? { filename: data.filename } : {}), ...(data.contentType ? { contentType: data.contentType } : {}) })) continue
        const att: ZoteroAttachmentRow = { key: it.key }
        if (data.path) att.path = data.path
        if (data.filename) att.filename = data.filename
        if (data.contentType) att.contentType = data.contentType
        const parent = typeof data.parentItem === 'string' ? data.parentItem : null
        if (parent) {
          const list = attachmentsByParent.get(parent) ?? []
          list.push(att)
          attachmentsByParent.set(parent, list)
        } else {
          // 独立 PDF 附件：自己就是一个「条目」
          orphans.push({
            key: it.key,
            title: data.title || attachmentFilename(att) || it.key,
            collectionIds: Array.isArray(data.collections) ? data.collections : [],
            attachments: [att],
          })
        }
        continue
      }
      if (data.itemType === 'note' || data.itemType === 'annotation') continue
      const row: ZoteroItemRow = {
        key: it.key,
        title: data.title || it.key,
        collectionIds: Array.isArray(data.collections) ? data.collections : [],
        attachments: [],
      }
      if (data.date) row.date = data.date
      const ck = data.citationKey ?? citationKeyFrom(data.extra)
      if (ck) row.citationKey = ck
      items.push(row)
    }
    if (batch.length < pageSize) break
  }

  for (const row of items) {
    const atts = attachmentsByParent.get(row.key)
    if (atts?.length) row.attachments.push(...atts)
  }

  return { source: 'api', zoteroDataDir: opts.zoteroDataDir, collections, items: [...items, ...orphans] }
}

// ── 来源二：只读 zotero.sqlite（node:sqlite） ───────────────────────────────

interface SqliteStatement {
  all(...params: unknown[]): unknown[]
}
interface SqliteDatabase {
  prepare(sql: string): SqliteStatement
  close(): void
}
interface SqliteModule {
  DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => SqliteDatabase
}

/** 动态拿 node:sqlite；不可用（老 Node / 被禁用）时返回 null，不抛。 */
export async function loadSqlite(): Promise<SqliteModule | null> {
  try {
    const mod = (await import(/* @vite-ignore */ 'node:sqlite')) as unknown as Partial<SqliteModule>
    return typeof mod?.DatabaseSync === 'function' ? (mod as SqliteModule) : null
  } catch {
    return null
  }
}

/**
 * 把带 WAL 的库整体复制到临时目录再查 —— 只读、不锁库、不碰 Zotero 任何文件。
 * Zotero 运行中会持有 WAL；不复制 -wal 会读到旧快照（实测）。
 */
export async function snapshotZoteroDb(zoteroDataDir: string): Promise<{ dir: string; dbPath: string }> {
  const src = join(zoteroDataDir, 'zotero.sqlite')
  if (!existsSync(src)) throw new ZoteroSyncError('zotero-db-missing', 503, '找不到 Zotero 数据库（zotero.sqlite）')
  const dir = await mkdtemp(join(tmpdir(), 'dpr-zotero-'))
  for (const suffix of ['', '-wal', '-shm']) {
    const from = src + suffix
    if (existsSync(from)) await copyFile(from, join(dir, 'zotero.sqlite' + suffix))
  }
  return { dir, dbPath: join(dir, 'zotero.sqlite') }
}

export async function readSqliteSnapshot(opts: {
  zoteroDataDir: string
  sqlite?: SqliteModule | null
}): Promise<ZoteroSnapshot> {
  const sqlite = opts.sqlite ?? (await loadSqlite())
  if (!sqlite) throw new ZoteroSyncError('sqlite-unavailable', 501, '当前 Node 运行时没有 node:sqlite，无法直读 Zotero 数据库')
  const { dir, dbPath } = await snapshotZoteroDb(opts.zoteroDataDir)
  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true })
  try {
    const rows = (sql: string, ...args: unknown[]) => db.prepare(sql).all(...args) as Array<Record<string, unknown>>
    const collections: ZoteroCollectionRow[] = rows(
      'SELECT collectionID, collectionName, parentCollectionID FROM collections',
    ).map((r) => ({
      id: String(r.collectionID),
      name: String(r.collectionName ?? ''),
      parentId: r.parentCollectionID == null ? null : String(r.parentCollectionID),
    }))

    // 条目字段：title / date / citationKey（Zotero 7 起 citationKey 是独立 field）
    const fieldOf = (itemId: unknown, fieldName: string): string | undefined => {
      const hit = rows(
        `SELECT v.value AS value FROM itemData d
           JOIN fields f ON f.fieldID = d.fieldID
           JOIN itemDataValues v ON v.valueID = d.valueID
          WHERE d.itemID = ? AND f.fieldName = ?`,
        itemId, fieldName,
      )
      return hit.length ? String(hit[0]!.value ?? '') : undefined
    }
    const keyOf = (itemId: unknown): string => {
      const hit = rows('SELECT key FROM items WHERE itemID = ?', itemId)
      return hit.length ? String(hit[0]!.key) : String(itemId)
    }

    const parents = rows(
      `SELECT i.itemID, i.key, it.typeName FROM items i
         JOIN itemTypes it ON it.itemTypeID = i.itemTypeID
        WHERE i.itemID NOT IN (SELECT itemID FROM deletedItems)
          AND i.itemID NOT IN (SELECT itemID FROM itemAttachments)
          AND i.itemID NOT IN (SELECT itemID FROM itemNotes)
          AND i.itemID NOT IN (SELECT itemID FROM itemAnnotations)`,
    )
    const items: ZoteroItemRow[] = parents.map((r) => {
      const itemId = r.itemID
      const collectionIds = rows('SELECT collectionID FROM collectionItems WHERE itemID = ?', itemId).map((c) =>
        String(c.collectionID),
      )
      const row: ZoteroItemRow = {
        key: String(r.key),
        title: fieldOf(itemId, 'title') || String(r.key),
        collectionIds,
        attachments: [],
      }
      const date = fieldOf(itemId, 'date')
      if (date) row.date = date
      const ck = fieldOf(itemId, 'citationKey')
      if (ck) row.citationKey = ck
      return row
    })
    const byKey = new Map(items.map((it) => [it.key, it]))

    const atts = rows(
      `SELECT a.itemID, a.parentItemID, a.path, a.contentType, ai.key AS attKey
         FROM itemAttachments a JOIN items ai ON ai.itemID = a.itemID
        WHERE a.itemID NOT IN (SELECT itemID FROM deletedItems)
          AND (a.contentType = 'application/pdf' OR lower(a.path) LIKE '%.pdf')`,
    )
    const orphanItems: ZoteroItemRow[] = []
    for (const a of atts) {
      const att: ZoteroAttachmentRow = { key: String(a.attKey) }
      if (a.path) att.path = String(a.path)
      if (a.contentType) att.contentType = String(a.contentType)
      if (a.parentItemID == null) {
        // 独立 PDF：没有父条目，自己算一条
        const title = fieldOf(a.itemID, 'title')
        const collectionIds = rows('SELECT collectionID FROM collectionItems WHERE itemID = ?', a.itemID).map((c) =>
          String(c.collectionID),
        )
        orphanItems.push({
          key: String(a.attKey),
          title: title || attachmentFilename(att) || String(a.attKey),
          collectionIds,
          attachments: [att],
        })
        continue
      }
      const parent = byKey.get(keyOf(a.parentItemID))
      if (parent) parent.attachments.push(att)
    }

    return { source: 'sqlite', zoteroDataDir: opts.zoteroDataDir, collections, items: [...items, ...orphanItems] }
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

// ── 来源自动选择 ────────────────────────────────────────────────────────────

/** Zotero 数据目录探测：显式配置 > ~/Zotero > %APPDATA%\Zotero\Zotero。 */
export function detectZoteroDataDir(configured?: string, home = homedir()): string | null {
  const candidates = [
    configured,
    join(home, 'Zotero'),
    join(process.env['APPDATA'] ?? '', 'Zotero', 'Zotero'),
  ].filter((p): p is string => typeof p === 'string' && p.length > 0)
  for (const dir of candidates) if (existsSync(join(dir, 'zotero.sqlite'))) return dir
  return null
}

export interface ZoteroStatus {
  enabled: boolean
  available: boolean
  source?: 'api' | 'sqlite'
  zoteroDataDir?: string
  apiBase: string
  reason?: string
}

/** 面板用来决定「要不要显示同步按钮」，以及失败时给人话原因。 */
export async function zoteroStatus(opts: {
  zotero?: ZoteroConfig
  fetchImpl?: FetchLike
  zoteroDataDir?: string
  /** 覆盖 HOME（只为测试：避免依赖开发机上有没装 Zotero）。 */
  home?: string
}): Promise<ZoteroStatus> {
  const cfg = opts.zotero ?? {}
  const apiBase = (cfg.apiBase ?? ZOTERO_DEFAULTS.apiBase).replace(/\/$/, '')
  const enabled = cfg.enabled ?? ZOTERO_DEFAULTS.enabled
  if (!enabled) return { enabled: false, available: false, apiBase, reason: 'disabled' }

  const dataDir = detectZoteroDataDir(opts.zoteroDataDir ?? cfg.dataDir, opts.home ?? homedir())
  const apiOk = await probeZoteroApi(apiBase, opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike))
  if (apiOk) {
    return { enabled: true, available: true, source: 'api', apiBase, ...(dataDir ? { zoteroDataDir: dataDir } : {}) }
  }
  const sqlite = await loadSqlite()
  if (dataDir && sqlite) {
    return { enabled: true, available: true, source: 'sqlite', apiBase, zoteroDataDir: dataDir }
  }
  const reason = !dataDir
    ? 'no-zotero-data-dir'
    : !sqlite
      ? 'sqlite-unavailable'
      : 'local-api-disabled'
  return { enabled: true, available: false, apiBase, reason, ...(dataDir ? { zoteroDataDir: dataDir } : {}) }
}

// ── 同步：把快照落成库目录 ──────────────────────────────────────────────────

/** 伴读插件为每篇文献生成、替换 PDF 后必须失效的转录产物（它按 .txt 大小判缓存，不看 mtime）。 */
const SIDECAR_SUFFIXES = ['.txt', '.pages.json', '.transcript.json', '.mineru.md', '.mineru.json', '.embeddings.json']
/** 译文变体不算用户文献（与 library.ts 的 PDF2ZH 口径一致）。 */
const TRANSLATION_SUFFIXES = ['-en', '-zh', '-dual']

export interface SyncSummary {
  ok: true
  source: 'api' | 'sqlite'
  zoteroDataDir: string
  /** 新增 / 更新 / 无变化 / 同内容跳过 的条数。 */
  counts: { created: number; updated: number; skipped: number; duplicates: number; pruned: number }
  /** 明细（截断到 30 条，避免响应体过大）；完整清单见 manifest。 */
  created: string[]
  updated: string[]
  duplicates: Array<{ name: string; sameAs: string }>
  pruned: string[]
  warnings: string[]
  topics: string[]
  /** 库里有、但不归本同步管的老文献（用户手动上传的），只提示不动。 */
  untouched: string[]
}

function sha1Of(file: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash('sha1')
    createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('end', () => res(h.digest('hex')))
      .on('error', rej)
  })
}

interface ManifestEntry {
  target: string
  topic: string
  name: string
  sha1: string
  size: number
  itemKey: string
  syncedAt: string
}
interface Manifest {
  version: 1
  attachments: Record<string, ManifestEntry>
}

async function loadManifest(path: string): Promise<Manifest> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as Partial<Manifest>
    if (raw && typeof raw === 'object' && raw.attachments && typeof raw.attachments === 'object') {
      return { version: 1, attachments: raw.attachments as Record<string, ManifestEntry> }
    }
  } catch { /* 首次同步 / 损坏 → 重新建 */ }
  return { version: 1, attachments: {} }
}

/** 目标路径必须在库根目录内（Zotero 里的名字是不可信输入，纵深防御）。 */
function assertInsideRoot(dataDir: string, target: string) {
  const root = resolve(dataDir)
  const abs = resolve(target)
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new ZoteroSyncError('escape-rejected', 400, '同步目标越出文献库目录，已拒绝')
  }
}

interface PlannedEntry {
  attachmentKey: string
  itemKey: string
  topic: string
  name: string
  src: string
  target: string
  action: 'create' | 'update' | 'skip' | 'duplicate'
  sameAs?: string
}

/**
 * 主入口：同步 Zotero → 文献库。
 *
 * 幂等：第二次运行全部 skip。改名/移动会按 manifest 的 attachment key 认人（不按文件名），
 * 所以 Zotero 里重命名条目 = 库里替换成新文件名，而不是多出一份。
 */
export async function syncFromZotero(opts: {
  dataDir: string
  zotero?: ZoteroConfig
  fetchImpl?: FetchLike
  sqlite?: SqliteModule | null
  dryRun?: boolean
  /** 把 Zotero 里已消失的文献移入 .zotero-sync/trash（默认只报告）。 */
  prune?: boolean
  now?: () => Date
  /** 覆盖 HOME（只为测试：让数据目录探测不依赖开发机环境）。 */
  home?: string
}): Promise<SyncSummary> {
  const cfg = opts.zotero ?? {}
  if ((cfg.enabled ?? ZOTERO_DEFAULTS.enabled) === false) {
    throw new ZoteroSyncError('zotero-disabled', 409, 'Zotero 同步已在插件配置里关闭')
  }
  const mode = cfg.mode ?? ZOTERO_DEFAULTS.mode
  const nameMode = cfg.nameMode ?? ZOTERO_DEFAULTS.nameMode
  const multi = cfg.multi ?? ZOTERO_DEFAULTS.multi
  const unfiled = cfg.unfiled ?? ZOTERO_DEFAULTS.unfiled

  // 1) 取快照（API 优先，失败退 sqlite）
  const zoteroDataDir = detectZoteroDataDir(cfg.dataDir, opts.home ?? homedir())
  let snapshot: ZoteroSnapshot | null = null
  const apiBase = (cfg.apiBase ?? ZOTERO_DEFAULTS.apiBase).replace(/\/$/, '')
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  if (await probeZoteroApi(apiBase, fetchImpl)) {
    snapshot = await readApiSnapshot({ apiBase, zoteroDataDir: zoteroDataDir ?? '', ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) })
  } else if (zoteroDataDir) {
    snapshot = await readSqliteSnapshot({ zoteroDataDir, sqlite: opts.sqlite ?? null })
  }
  if (!snapshot) {
    throw new ZoteroSyncError(
      'zotero-unavailable',
      503,
      '连不上 Zotero：请在 Zotero「设置 → 高级」勾选「允许此计算机上的其他应用程序与 Zotero 通信」，或确认 Zotero 数据目录存在',
    )
  }

  // 2) 计算每条文献的目标（专题 + 文件名）
  const topics = topicNamesFor(snapshot.collections)
  const planned: PlannedEntry[] = []
  const warnings: string[] = []
  const usedName = new Map<string, number>()

  for (const item of snapshot.items) {
    if (item.attachments.length === 0) continue
    const att = item.attachments[0]!
    const src = attachmentFile(snapshot.zoteroDataDir, att)
    if (!src || !existsSync(src)) {
      warnings.push(`附件文件缺失：${item.title}`)
      continue
    }
    const topicList: string[] = []
    for (const cid of item.collectionIds) {
      const t = topics.get(cid)
      if (t && !topicList.includes(t)) topicList.push(t)
    }
    if (topicList.length === 0) topicList.push(sanitizeName(unfiled, 60))
    const targetTopics = multi ? topicList : [topicList[0]!]

    const stemRaw = attachmentFilename(att) ?? item.title
    const stem = stemRaw.replace(/\.pdf$/i, '')
    let baseName: string
    if (nameMode === 'key') baseName = item.key
    else if (nameMode === 'citekey' && item.citationKey) baseName = `${item.citationKey} - ${stem}`
    else baseName = stem || item.title || item.key

    for (const topic of targetTopics) {
      const name = sanitizeName(baseName, 120)
      // 同名冲突（不同条目抢一个文件名）→ 追加条目 key，与 Zotero 里的重复条目对应
      const key = `${topic}\u0000${name}`
      const seen = (usedName.get(key) ?? 0) + 1
      usedName.set(key, seen)
      const finalName = seen === 1 ? name : sanitizeName(`${name} (${item.key})`, 120)
      const target = join(opts.dataDir, topic, finalName + '.pdf')
      assertInsideRoot(opts.dataDir, target)
      planned.push({
        attachmentKey: att.key,
        itemKey: item.key,
        topic,
        name: finalName,
        src,
        target,
        action: 'create',
      })
    }
  }

  // 3) 与磁盘现状比对（同内容去重、新增、更新）
  const manifestPath = join(opts.dataDir, '.zotero-sync', 'manifest.json')
  const manifest = await loadManifest(manifestPath)
  const hashCache = new Map<string, string>()
  const sha1 = async (file: string) => {
    const hit = hashCache.get(file)
    if (hit) return hit
    const h = await sha1Of(file)
    hashCache.set(file, h)
    return h
  }
  const existingByTopic = new Map<string, Map<string, { path: string; size: number }>>()
  for (const topic of new Set(planned.map((p) => p.topic))) {
    const dir = join(opts.dataDir, topic)
    const map = new Map<string, { path: string; size: number }>()
    if (existsSync(dir)) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.pdf')) continue
        const stem = entry.name.slice(0, -4)
        if (TRANSLATION_SUFFIXES.some((s) => stem.endsWith(s))) continue
        const full = join(dir, entry.name)
        const info = await stat(full)
        map.set(stem, { path: full, size: info.size })
      }
    }
    existingByTopic.set(topic, map)
  }

  for (const p of planned) {
    const srcSize = (await stat(p.src)).size
    const srcSha = await sha1(p.src)
    const prior = Object.values(manifest.attachments).find((m) => m.target === p.target)
    if (existsSync(p.target)) {
      const targetSha = await sha1(p.target)
      p.action = targetSha === srcSha ? 'skip' : 'update'
      continue
    }
    // 同内容已存在（用户手动上传过同一篇 / 上次改名前的旧名）→ 不重复入库
    const siblings = existingByTopic.get(p.topic)
    let dupOf: string | undefined
    if (siblings) {
      for (const [stem, info] of siblings) {
        if (info.size !== srcSize) continue
        if ((await sha1(info.path)) === srcSha) { dupOf = stem; break }
      }
    }
    if (dupOf) { p.action = 'duplicate'; p.sameAs = dupOf }
    else if (prior) p.action = 'update'
    else p.action = 'create'
  }

  // 4) 落盘
  const summary: SyncSummary = {
    ok: true,
    source: snapshot.source,
    zoteroDataDir: snapshot.zoteroDataDir,
    counts: { created: 0, updated: 0, skipped: 0, duplicates: 0, pruned: 0 },
    created: [],
    updated: [],
    duplicates: [],
    pruned: [],
    warnings,
    topics: [...new Set(planned.map((p) => p.topic))].sort(),
    untouched: [],
  }
  const nowIso = (opts.now?.() ?? new Date()).toISOString()
  const dryRun = opts.dryRun === true

  for (const p of planned) {
    if (p.action === 'skip') { summary.counts.skipped++; continue }
    if (p.action === 'duplicate') {
      summary.counts.duplicates++
      summary.duplicates.push({ name: `${p.topic}/${p.name}`, sameAs: `${p.topic}/${p.sameAs ?? ''}` })
      continue
    }
    if (dryRun) {
      if (p.action === 'create') { summary.counts.created++; summary.created.push(`${p.topic}/${p.name}`) }
      else { summary.counts.updated++; summary.updated.push(`${p.topic}/${p.name}`) }
      continue
    }
    await mkdir(join(opts.dataDir, p.topic), { recursive: true })
    if (p.action === 'update') {
      // PDF 换了内容：先删转录缓存，否则会继续用旧文本（插件只按 .txt 大小判缓存）
      for (const suffix of SIDECAR_SUFFIXES) {
        await rm(join(opts.dataDir, p.topic, p.name + suffix), { force: true }).catch(() => {})
      }
      const tmp = p.target + '.dpr-sync.tmp'
      await rm(tmp, { force: true }).catch(() => {})
      if (!(await linkOrCopy(p.src, tmp, mode))) throw new ZoteroSyncError('sync-write-failed', 500, `写入失败：${p.name}`)
      await rename(tmp, p.target)
      summary.counts.updated++
      summary.updated.push(`${p.topic}/${p.name}`)
    } else {
      await linkOrCopy(p.src, p.target, mode)
      summary.counts.created++
      summary.created.push(`${p.topic}/${p.name}`)
    }
    manifest.attachments[p.attachmentKey] = {
      target: p.target,
      topic: p.topic,
      name: p.name,
      sha1: await sha1(p.src),
      size: (await stat(p.src)).size,
      itemKey: p.itemKey,
      syncedAt: nowIso,
    }
  }

  // 5) 孤儿：上次同步过、这次 Zotero 里没了（删除 / 进回收站 / 移出合集）
  const liveTargets = new Set(planned.map((p) => p.target))
  for (const [attKey, entry] of Object.entries(manifest.attachments)) {
    if (liveTargets.has(entry.target)) continue
    if (!existsSync(entry.target)) { delete manifest.attachments[attKey]; continue }
    summary.pruned.push(`${entry.topic}/${entry.name}`)
    summary.counts.pruned++
    if (!dryRun && opts.prune) {
      const stamp = nowIso.replace(/[:.]/g, '-')
      const dst = join(opts.dataDir, '.zotero-sync', 'trash', stamp, entry.topic, entry.name + '.pdf')
      await mkdir(join(dst, '..'), { recursive: true })
      await rename(entry.target, dst).catch(async () => {
        await copyFile(entry.target, dst)
        await rm(entry.target, { force: true })
      })
      delete manifest.attachments[attKey]
    }
  }
  if (summary.pruned.length && !opts.prune) {
    summary.warnings.push(`有 ${summary.pruned.length} 篇已在 Zotero 里消失（未删除，传 prune 可移入回收目录）`)
  }

  // 6) 库里有、但不归本同步管的老文献：只提示，绝不动
  const managed = new Set(Object.values(manifest.attachments).map((m) => m.target))
  for (const [topic, siblings] of existingByTopic) {
    for (const [stem, info] of siblings) {
      if (!managed.has(info.path) && !planned.some((p) => p.target === info.path)) {
        summary.untouched.push(`${topic}/${stem}`)
      }
    }
  }

  if (!dryRun) {
    await mkdir(join(opts.dataDir, '.zotero-sync'), { recursive: true })
    const tmp = manifestPath + '.tmp'
    await writeFile(tmp, JSON.stringify(manifest, null, 2), 'utf8')
    await rename(tmp, manifestPath)
  }

  // 响应体瘦身：明细最多 30 条
  summary.created = summary.created.slice(0, 30)
  summary.updated = summary.updated.slice(0, 30)
  summary.duplicates = summary.duplicates.slice(0, 10)
  summary.pruned = summary.pruned.slice(0, 30)
  summary.untouched = summary.untouched.slice(0, 10)
  return summary
}

/** 硬链接优先（省空间、与 Zotero 共享数据），跨盘/权限失败时退化为复制。 */
async function linkOrCopy(src: string, dst: string, mode: 'link' | 'copy'): Promise<boolean> {
  if (mode === 'link') {
    try {
      await link(src, dst)
      return true
    } catch { /* EXDEV / 权限 / 目标已存在 → 复制 */ }
  }
  try {
    await copyFile(src, dst)
    return true
  } catch {
    return false
  }
}
