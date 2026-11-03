// test/rightbar-layout.test.mjs — rightbar 布局契约（守卫「不做列换位」）。
//
// 历史：上游 v1.3+ 打开 PDF 页签时会把 rightbar 列与 center 列**互换**，让 PDF 占主区、
// 对话挤到最右。用户反馈「论文怎么跑到左边去了」，这个 fork 移除了换位 —— PDF 留在
// 右侧栏、对话留在主区，列/行/面板宽度一律交回 dsh 自己的布局。
//
// 本文件守两件事：
//   1) 布局函数**永远不写** gridColumn / gridRow / maxWidth / minWidth（换位被重新引入 → 红）；
//   2) 与换位无关的全屏层级修复**还在**（全屏时 iframe 要盖过 dsh 的 tab 宿主）。
//
// 怎么守：不重写实现，直接从 lib/client.js 抽出 setStyle + applyLayout 真源码，在假 DOM 里跑
// （同本仓库既有的「源码区段抽取 + 独立复算」套路）。抽取标记被重构掉 → C0 直接报错指认。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeEol } from './reader-script.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
const CLIENT = normalizeEol(readFileSync(join(ROOT, '..', 'lib', 'client.js'), 'utf8'))

/* ---------- C0：抽取 setStyle + applyLayout 真源码 ---------- */
const SRC_START = CLIENT.indexOf('const setStyle = (el, prop, val)')
const SRC_END = CLIENT.indexOf('const tick = () => {')
assert.ok(SRC_START >= 0 && SRC_END > SRC_START, 'lib/client.js 抽取标记 setStyle/tick 仍在')
const LAYOUT_SRC = CLIENT.slice(SRC_START, SRC_END)
assert.ok(LAYOUT_SRC.includes('applyLayout'), '抽取区段里应有 applyLayout')

/* ---------- 假 DOM：只实现 applyLayout 用到的面 ---------- */
function makeDom({ dockLayer = '40', fullscreen = false, noCol = false } = {}) {
  const panel = { style: {} }
  const attrs = fullscreen ? { 'data-rightbar-fullscreen': '' } : {}
  const frame = { hasAttribute: (n) => Object.hasOwn(attrs, n) }
  const col = {
    style: {},
    parentElement: frame,
    querySelector: (sel) => (sel === '[data-sidebar-right-panel]' ? panel : null),
  }
  const center = {
    style: {},
    // 若实现偷偷改布局，这里会带上被写的属性 —— 测试据此报红
    setProperty: () => { throw new Error('center 不应被改写') },
  }
  const document = {
    querySelector: (sel) => {
      if (noCol) return null
      if (sel === '[data-rightbar-col]') return col
      return null
    },
  }
  const iframe = { style: {} }
  const getComputedStyle = (el) => ({
    gridTemplateColumns: '56px 700px 280px',
    getPropertyValue: (p) => (el === panel && p === '--dsh-dockkit-dock-layer' ? dockLayer : ''),
  })
  const applyLayout = new Function('document', 'getComputedStyle', 'readerIframeEl', LAYOUT_SRC + '\nreturn applyLayout')(
    document, getComputedStyle, iframe,
  )
  return { col, center, panel, iframe, applyLayout }
}

test('C0: 布局函数不包含换位实现（防止「论文跑到左边」回归）', () => {
  // 换位靠把 rightbar 列钉到第 2 轨、对话列钉到第 3 轨；这两个写入是唯一的实现点。
  assert.ok(!/gridColumn/.test(LAYOUT_SRC), '布局函数不得再写 gridColumn（换位已被移除）')
  assert.ok(!/gridRow/.test(LAYOUT_SRC), '布局函数不得再写 gridRow')
  assert.ok(!/maxWidth|minWidth/.test(LAYOUT_SRC), '布局函数不得再改面板宽度钳制')
  assert.ok(!/applySwap/.test(CLIENT), 'lib/client.js 不得残留 applySwap')
  assert.ok(!/data-dpr-tab/.test(CLIENT), 'PdfTab 的换位标记 data-dpr-tab 应已删除')
})

test('C1: 打开 PDF 时列布局保持 dsh 默认（不钉列、不钳宽度）', () => {
  const dom = makeDom()
  dom.applyLayout()
  assert.deepEqual(dom.col.style, {}, 'rightbar 列不应被写入任何内联样式')
  assert.deepEqual(dom.center.style, {}, '对话列不应被写入任何内联样式')
  assert.deepEqual(dom.panel.style, {}, '面板不应被钳制宽度')
})

test('C2: 全屏态层级修复仍在——iframe 抬到 dockLayer+2，非全屏回 10', () => {
  const normal = makeDom()
  normal.applyLayout()
  assert.equal(normal.iframe.style.zIndex, '10', '非全屏：低于拖拽手柄(11)与 overlayLayer(20)')

  const full = makeDom({ fullscreen: true })
  full.applyLayout()
  assert.equal(full.iframe.style.zIndex, '42', '全屏：dockLayer(40)+2，盖回 dsh 的 tab 宿主')
})

test('C3: 没有 rightbar 列时安全返回（页面刚挂载 / 会话未就绪）', () => {
  const dom = makeDom({ noCol: true })
  assert.doesNotThrow(() => dom.applyLayout())
})
