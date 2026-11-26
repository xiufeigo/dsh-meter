// Smoke-render the dsh-quota-badge client half with a fake React and fake ctx.
// Usage: node smoke.mjs
import fs from 'node:fs'
import vm from 'node:vm'

const SOURCE = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

const problems = []
const notes = []

// ── fake React ────────────────────────────────────────────────────────
let STUBS = []
const React = {
  Fragment: Symbol('Fragment'),
  createElement (type, props, ...children) {
    const flat = children.length <= 1 ? children[0] : children
    return { type, props: { ...(props ?? {}), children: flat } }
  },
  useState (initial) {
    if (STUBS.length > 0) return [STUBS.shift(), () => {}]
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useRef (initial) { return { current: initial ?? null } },
  useEffect () {},
  useLayoutEffect () {},
  useMemo (factory) { return factory() },
  useCallback (fn) { return fn },
  Component: class Component {
    constructor (props) { this.props = props }
  },
}
const ReactDOM = { createPortal: (node) => ({ portal: node }) }

// ── fake DOM ──────────────────────────────────────────────────────────
const fakeElement = () => ({
  style: {},
  value: '',
  setAttribute () {},
  remove () {},
  select () {},
  focus () {},
  contains () { return false },
  getBoundingClientRect () { return { top: 0, bottom: 20, left: 0, right: 100, width: 100, height: 20 } },
  appendChild () {},
})
const document = {
  body: fakeElement(),
  activeElement: null,
  createElement: () => fakeElement(),
  execCommand: () => true,
  addEventListener () {},
  removeEventListener () {},
}

// ── capture dictionaries from ctx.locale.register ─────────────────────
const dicts = {}
let activeLocale = 'zh'
const missingKeys = new Set()
const usedKeys = new Set()
const translate = (ns, key, params) => {
  usedKeys.add(key)
  const locale = activeLocale
  const d = dicts[ns]?.[locale] ?? {}
  let text = d[key]
  if (typeof text !== 'string') {
    const fallback = dicts[ns]?.en ?? {}
    text = fallback[key]
    if (typeof text !== 'string') { missingKeys.add(key); return `!!${key}!!` }
  }
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) text = text.split(`{${name}}`).join(String(value))
  }
  return text
}

const registrations = []
const ctx = {
  effect (fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
  locale: {
    register (ns, locale, dict) { (dicts[ns] ??= {})[locale] = dict },
    bind (ns) { return (key, params) => translate(ns, key, params) },
  },
  slots: {
    inject (name, callback) {
      const value = callback()
      registrations.push({ name, ...value })
      return () => {}
    },
    register (spec, comp) { return { spec, comp } },
  },
}

// ── load the bundle ───────────────────────────────────────────────────
const window = { __ModuleLoader__: { load ({ id, factory }) { module.exports = factory(require) } } }
const require = (spec) => {
  if (spec === 'react') return React
  if (spec === 'react-dom') return ReactDOM
  throw new Error(`unexpected require("${spec}")`)
}
const module = { exports: {} }
const sandbox = {
  window,
  require,
  document,
  navigator: { clipboard: { writeText: async () => {} } },
  fetch: async () => ({ ok: true, json: async () => ({ status: 'ok', windows: [] }) }),
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(SOURCE, sandbox, { filename: 'client.js' })

const api = module.exports
if (typeof api?.apply !== 'function') throw new Error('client half exported no apply()')
api.apply(ctx)

// ── renderer: walk elements, running function components ──────────────
function expandNode (node, depth = 0) {
  if (depth > 40) return null
  if (node === null || node === undefined || node === false || node === true) return null
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((child) => expandNode(child, depth + 1))
  if (typeof node !== 'object') return null
  if ('portal' in node) return expandNode(node.portal, depth + 1)
  const { type, props } = node
  if (type === React.Fragment) return expandNode(props?.children, depth + 1)
  if (typeof type === 'function') {
    let rendered
    if (type.prototype !== undefined && typeof type.prototype.render === 'function') {
      const instance = new type(props)
      instance.state = type.getDerivedStateFromError === undefined ? {} : { error: null }
      rendered = instance.render()
    } else {
      rendered = type(props)
    }
    return expandNode(rendered, depth + 1)
  }
  if (type === 'style') return null
  return { type, props: { ...(props ?? {}), children: expandNode(props?.children, depth + 1) } }
}

function toText (node, depth = 0) {
  const expanded = depth === 0 ? expandNode(node, 0) : node
  if (expanded === null || expanded === undefined) return ''
  if (typeof expanded === 'string') return expanded
  if (Array.isArray(expanded)) return expanded.map((child) => toText(child, depth + 1)).join('')
  return toText(expanded.props?.children, depth + 1)
}

function countElements (expanded, tag) {
  if (expanded === null || expanded === undefined || typeof expanded === 'string') return 0
  if (Array.isArray(expanded)) return expanded.reduce((n, c) => n + countElements(c, tag), 0)
  return (expanded.type === tag ? 1 : 0) + countElements(expanded.props?.children, tag)
}

const styles = (node) => toText(node) // placeholder

const renderCell = (slotName, props, stubs) => {
  STUBS = stubs ?? []
  const reg = registrations.find((entry) => entry.name === slotName)
  if (reg === undefined) throw new Error(`no registration for ${slotName}`)
  const wrapper = reg.comp(props)
  const inner = wrapper?.props?.children
  if (inner === undefined || typeof inner.type !== 'function') throw new Error(`unexpected wrapper for ${slotName}`)
  STUBS = stubs ?? []
  return inner.type(inner.props)
}

const t = (key, params) => translate('quota-badge', key, params)

const okWindows = [
  { key: '5h', percent: 0, resetsAt: new Date(Date.now() + 3 * 3600e3).toISOString() },
  { key: '7d', percent: 0, resetsAt: new Date(Date.now() + 4 * 86400e3).toISOString() },
  { key: '30d', percent: 22, resetsAt: new Date(Date.now() + 24 * 86400e3).toISOString() },
]
const okPayload = {
  status: 'ok', family: 'opencode-go', providerLabel: 'OpenCode Go',
  fetchedAt: Date.now(), windows: okWindows, provider: 'opencodegoresponse',
}
const selectionOf = (provider, model) => () => ({ next: { provider, model } })

// ── 1. ok state (closed) ──────────────────────────────────────────────
let tree = renderCell('conversation.composer.dock', {
  useProjection: selectionOf('opencodegoresponse', 'deepseek-v4.1-flash'),
  t,
  sessionId: 's1',
}, [false, null, 0, okPayload])
let text = toText(tree)
notes.push(`[ok-closed-zh] ${text.trim()}`)
if (!text.includes('100%')) problems.push(`ok state: expected the shortest-period reading (5h → 100%) in the trigger, got "${text.trim()}"`)
if (text.includes('%') && !text.includes('30d')) { /* ring only shows number */ }

// ── 2. ok state (open -> panel) ───────────────────────────────────────
tree = renderCell('conversation.composer.dock', {
  useProjection: selectionOf('opencodegoresponse', 'deepseek-v4.1-flash'),
  t,
}, [true, null, 0, okPayload])
text = toText(tree)
notes.push(`[ok-open-zh] ${text.trim()}`)
for (const expected of ['额度限制', '滚动', '周', '月', '5h', '7d', '30d', '剩余 100%', '刷新']) {
  if (!text.includes(expected)) problems.push(`open panel: missing "${expected}"`)
}

// ── 3. no-credential (stepfun) ────────────────────────────────────────
tree = renderCell('conversation.composer.dock', {
  useProjection: selectionOf('stepfun', 'step-5-preview'),
  t,
}, [false, null, 0, {
  status: 'no-credential', family: 'stepfun', providerLabel: 'StepFun',
  setupFamily: 'stepfun', message: 'StepFun console cookie not configured', windows: [],
}])
text = toText(tree)
notes.push(`[no-credential-zh] ${text.trim()}`)
if (!text.includes('绑定')) problems.push(`no-credential: expected 绑定, got "${text.trim()}"`)

// ── 4. no-credential + bind modal (click behaviour) ───────────────────
tree = renderCell('conversation.composer.dock', {
  useProjection: selectionOf('stepfun', 'step-5-preview'),
  t,
}, [false, 'stepfun', 0, {
  status: 'no-credential', family: 'stepfun', providerLabel: 'StepFun',
  setupFamily: 'stepfun', message: 'StepFun console cookie not configured', windows: [],
}])
text = toText(tree)
notes.push(`[bind-modal-zh] ${text.trim()}`)
for (const expected of ['绑定 StepFun 控制台', '浏览器登录并自动绑定', '或者手动粘贴 Cookie', '取消']) {
  if (!text.includes(expected)) problems.push(`bind modal: missing "${expected}"`)
}

// ── 5. error state ────────────────────────────────────────────────────
tree = renderCell('conversation.composer.dock', {
  useProjection: selectionOf('kimi', 'k3-256k'),
  t,
}, [false, null, 0, { status: 'error', provider: 'kimi', windows: [], message: 'boom' }])
text = toText(tree)
notes.push(`[error-zh] ${text.trim()}`)
if (!text.includes('!')) problems.push('error state: expected "!" trigger')

// ── 6. unsupported renders no trigger ─────────────────────────────────
tree = renderCell('conversation.composer.dock', {
  useProjection: selectionOf('openai', 'gpt-6-luna'),
  t,
}, [false, null, 0, { status: 'unsupported', provider: 'openai', windows: [] }])
if (toText(tree).trim() !== '') problems.push(`unsupported state rendered "${toText(tree).trim()}"`)

// ── 7. english locale ─────────────────────────────────────────────────
activeLocale = 'en'
tree = renderCell('conversation.composer.dock', {
  useProjection: selectionOf('opencodegoresponse', 'deepseek-v4.1-flash'),
  t,
}, [true, null, 0, okPayload])
text = toText(tree)
notes.push(`[ok-open-en] ${text.trim()}`)
for (const expected of ['Usage limits', 'Rolling', 'Weekly', 'Monthly', 'left 100%']) {
  if (!text.includes(expected)) problems.push(`en panel: missing "${expected}"`)
}

// ── 8. settings section (zh + en) ────────────────────────────────────
activeLocale = 'zh'
const settingsReg = registrations.find((entry) => entry.name === 'settings.plugins.tab')
STUBS = []
const settingsTreeZh = settingsReg.comp()
const settingsExpandedZh = expandNode(settingsTreeZh)
text = toText(settingsExpandedZh, 1)
notes.push(`[settings-zh] ${text.trim()}`)
for (const expected of ['StepFun', '小米 MiMo', '浏览器登录并自动绑定', '从 Edge 读取 Cookie', '控制台类套餐', 'Sub2API', 'New API', '重新通过 URL 自动识别']) {
  if (!text.includes(expected)) problems.push(`settings zh: missing "${expected}"`)
}
if (countElements(settingsExpandedZh, 'select') < 2) {
  problems.push(`settings zh: expected >= 2 <select> dropdowns for Sub2API & New API, got ${countElements(settingsExpandedZh, 'select')}`)
}

activeLocale = 'en'
STUBS = []
const settingsTreeEn = settingsReg.comp()
const settingsExpandedEn = expandNode(settingsTreeEn)
text = toText(settingsExpandedEn, 1)
notes.push(`[settings-en] ${text.trim()}`)
for (const expected of ['StepFun', 'Open browser & bind automatically', 'Read Cookie from Edge', 'Sub2API', 'New API', 'Auto-detect by URL']) {
  if (!text.includes(expected)) problems.push(`settings en: missing "${expected}"`)
}
if (countElements(settingsExpandedEn, 'select') < 2) {
  problems.push(`settings en: expected >= 2 <select> dropdowns for Sub2API & New API, got ${countElements(settingsExpandedEn, 'select')}`)
}
activeLocale = 'zh'

// ── 9. single-window plan: no redundant row, only the reset line ──────
const singlePayload = {
  status: 'ok', family: 'stepfun', providerLabel: 'StepFun',
  fetchedAt: Date.now(), provider: 'stepfun',
  windows: [{ key: '30d', percent: 0.9, resetsAt: new Date(Date.now() + 24 * 86400e3).toISOString() }],
}
tree = renderCell('conversation.composer.dock', {
  useProjection: selectionOf('stepfun', 'step-5-preview'),
  t,
}, [true, null, 0, singlePayload])
text = toText(tree)
notes.push(`[single-window-zh] ${text.trim()}`)
if (!text.includes('剩余 99%')) problems.push('single window: header must keep 剩余 99%')
if (!text.includes('重置')) problems.push('single window: reset date must render')
if (text.includes('30d')) problems.push('single window: the 月/30d row must not repeat')

// ── 10. balance-only official route: account badge + panel ───────────
activeLocale = 'zh'
const accountPayload = {
  status: 'ok', family: 'deepseek-account', providerLabel: 'DeepSeek Account',
  fetchedAt: Date.now(), provider: 'deepseek-account',
  windows: [
    { key: 'balance', percent: null, resetsAt: null, text: '¥12.34' },
    { key: 'bonus', percent: null, resetsAt: null, text: '¥2.00' },
  ],
}
tree = renderCell('conversation.composer.dock', {
  useProjection: selectionOf('deepseek-account', 'deepseek-flash'),
  t,
}, [false, null, 0, accountPayload])
text = toText(tree)
notes.push(`[balance-closed-zh] ${text.trim()}`)
if (!text.includes('¥12.34')) problems.push(`balance badge: expected the total balance, got "${text.trim()}"`)
if (text.includes('%')) problems.push('balance badge: must not render a percentage')

tree = renderCell('conversation.composer.dock', {
  useProjection: selectionOf('deepseek-account', 'deepseek-flash'),
  t,
}, [true, null, 0, accountPayload])
text = toText(tree)
notes.push(`[balance-open-zh] ${text.trim()}`)
for (const expected of ['DeepSeek 账号', '额度限制', '余额', '¥12.34', '赠送', '¥2.00', '刷新']) {
  if (!text.includes(expected)) problems.push(`balance panel: missing "${expected}"`)
}

// ── 11. balance-only official route: API-key badge ────────────────────
const officialPayload = {
  status: 'ok', family: 'deepseek-official', providerLabel: 'DeepSeek',
  fetchedAt: Date.now(), provider: 'deepseek-official',
  windows: [{ key: 'balance', percent: null, resetsAt: null, text: '¥8.00' }],
}
tree = renderCell('conversation.composer.dock', {
  useProjection: selectionOf('deepseek-official', 'deepseek-flash'),
  t,
}, [false, null, 0, officialPayload])
text = toText(tree)
notes.push(`[official-closed-zh] ${text.trim()}`)
if (!text.includes('¥8.00')) problems.push(`official badge: expected the balance, got "${text.trim()}"`)

tree = renderCell('conversation.composer.dock', {
  useProjection: selectionOf('deepseek-official', 'deepseek-flash'),
  t,
}, [true, null, 0, officialPayload])
text = toText(tree)
notes.push(`[official-open-zh] ${text.trim()}`)
for (const expected of ['DeepSeek', '余额', '¥8.00']) {
  if (!text.includes(expected)) problems.push(`official panel: missing "${expected}"`)
}

// ── 12. signed-out account: not a console binding ─────────────────────
tree = renderCell('conversation.composer.dock', {
  useProjection: selectionOf('deepseek-account', 'deepseek-flash'),
  t,
}, [false, null, 0, {
  status: 'no-credential', family: 'deepseek-account', providerLabel: 'DeepSeek Account',
  setupFamily: null, message: 'DeepSeek account is not signed in', windows: [],
}])
text = toText(tree)
notes.push(`[account-signed-out-zh] ${text.trim()}`)
if (!text.includes('未连接')) problems.push(`signed-out account: expected 未连接, got "${text.trim()}"`)
if (text.includes('绑定')) problems.push('signed-out account: must not ask to bind a console cookie')

// ── 13. english balance panel ─────────────────────────────────────────
activeLocale = 'en'
tree = renderCell('conversation.composer.dock', {
  useProjection: selectionOf('deepseek-account', 'deepseek-flash'),
  t,
}, [true, null, 0, accountPayload])
text = toText(tree)
notes.push(`[balance-open-en] ${text.trim()}`)
for (const expected of ['DeepSeek Account', 'Usage limits', 'Balance', 'Granted', '¥12.34']) {
  if (!text.includes(expected)) problems.push(`en balance panel: missing "${expected}"`)
}
activeLocale = 'zh'

// ── 14. Sub2API & New API gateway panels (zh + en) ────────────────────
const sub2apiPayload = {
  status: 'ok', family: 'sub2api', providerLabel: 'Sub2API · d1studio',
  fetchedAt: Date.now(), provider: 'd1studio',
  windows: [
    { key: '1d', percent: 10, resetsAt: null },
    { key: 'quota', percent: 25, resetsAt: null },
    { key: 'balance', percent: null, resetsAt: null, text: '$8.50' },
    { key: 'today', percent: null, resetsAt: null, text: '$1.20' },
  ],
}
tree = renderCell('conversation.composer.dock', {
  useProjection: selectionOf('d1studio', 'claude-sonnet'),
  t,
}, [true, null, 0, sub2apiPayload])
text = toText(tree)
notes.push(`[sub2api-open-zh] ${text.trim()}`)
for (const expected of ['Sub2API · d1studio', '剩余 90%', '总额度', '75%', '余额', '$8.50', '今日', '$1.20']) {
  if (!text.includes(expected)) problems.push(`sub2api zh panel: missing "${expected}"`)
}

activeLocale = 'en'
tree = renderCell('conversation.composer.dock', {
  useProjection: selectionOf('d1studio', 'claude-sonnet'),
  t,
}, [true, null, 0, sub2apiPayload])
text = toText(tree)
notes.push(`[sub2api-open-en] ${text.trim()}`)
for (const expected of ['Sub2API · d1studio', 'left 90%', 'Quota', 'Balance', '$8.50', 'Today', '$1.20']) {
  if (!text.includes(expected)) problems.push(`sub2api en panel: missing "${expected}"`)
}
activeLocale = 'zh'

const newApiPayload = {
  status: 'ok', family: 'new-api', providerLabel: 'New API · myrelay',
  fetchedAt: Date.now(), provider: 'myrelay',
  windows: [
    { key: 'quota', percent: 40, resetsAt: new Date(Date.now() + 3600e3 * 48).toISOString() },
    { key: 'balance', percent: null, resetsAt: null, text: '$12.00' },
    { key: 'used', percent: null, resetsAt: null, text: '$8.00' },
  ],
}
tree = renderCell('conversation.composer.dock', {
  useProjection: selectionOf('myrelay', 'gpt-4o'),
  t,
}, [true, null, 0, newApiPayload])
text = toText(tree)
notes.push(`[newapi-open-zh] ${text.trim()}`)
for (const expected of ['New API · myrelay', '剩余 60%', '余额', '$12.00', '已用', '$8.00']) {
  if (!text.includes(expected)) problems.push(`new-api zh panel: missing "${expected}"`)
}

activeLocale = 'en'
tree = renderCell('conversation.composer.dock', {
  useProjection: selectionOf('myrelay', 'gpt-4o'),
  t,
}, [true, null, 0, newApiPayload])
text = toText(tree)
notes.push(`[newapi-open-en] ${text.trim()}`)
for (const expected of ['New API · myrelay', 'left 60%', 'Balance', '$12.00', 'Used', '$8.00']) {
  if (!text.includes(expected)) problems.push(`new-api en panel: missing "${expected}"`)
}
activeLocale = 'zh'

// ── 15. recovery opened a login window: the badge says so, not "bind" ──
activeLocale = 'zh'
tree = renderCell('conversation.composer.dock', {
  useProjection: selectionOf('xiaomi-token-plan-cn', 'mimo-v2.6-flash'),
  t,
}, [false, null, 0, {
  status: 'no-credential', expired: true, family: 'mimo', providerLabel: 'MiMo',
  setupFamily: 'mimo', loginWindow: 'opened', message: 'MiMo 登录窗口已打开，完成登录后徽章会自动恢复', windows: [],
}])
text = toText(tree)
notes.push(`[login-window-zh] ${text.trim()}`)
if (!text.includes('登录中…')) problems.push(`login window: expected ⏳ 登录中…, got "${text.trim()}"`)
if (text.includes('绑定')) problems.push('login window: must not ask the user to bind while the window is open')

// Settings carries the username & password block for both consoles.
for (const [label, expanded, expected] of [
  ['zh', settingsExpandedZh, ['账号密码登录', '不用浏览器，也不用 Edge', '仍需你在窗口里输入验证码']],
  ['en', settingsExpandedEn, ['Username & password', 'no browser, no Edge', 'verification code']],
]) {
  for (const needle of expected) {
    if (!toText(expanded, 1).includes(needle)) problems.push(`settings ${label}: missing "${needle}"`)
  }
}

// ── report ────────────────────────────────────────────────────────────
console.log(notes.join('\n\n'))
console.log(`\nused locale keys: ${[...usedKeys].sort().join(', ')}`)
if (missingKeys.size > 0) problems.push(`missing locale keys: ${[...missingKeys].join(', ')}`)
if (problems.length > 0) {
  console.log('\nPROBLEMS:')
  for (const problem of problems) console.log(` - ${problem}`)
  process.exitCode = 1
} else {
  console.log('\nALL SMOKE CHECKS PASSED')
}




