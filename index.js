/**
 * dsh-meter — Host half.
 *
 * Same-origin routes on the harness web server:
 *
 *   GET  /plugins/dsh-meter/quota?provider=<ns>&model=<id>
 *        Resolves the provider's credential through the harness credential
 *        seam and queries that plan's usage endpoint.
 *   GET  /plugins/dsh-meter/setup?family=<stepfun|mimo>
 *        Paste page for the two console-cookie families.
 *   POST /plugins/dsh-meter/setup?family=...   { cookie }
 *        Validates a pasted console cookie and stores it in the credential
 *        store (STEPFUN_COOKIE / MIMO_COOKIE).
 *   GET  /plugins/dsh-meter/status
 *        Diagnostics: client-graph membership, provider routing, credential
 *        seam state, and the recent client-half report buffer.
 *   POST /plugins/dsh-meter/login/start?family=<stepfun|mimo>&mode=auto
 *        Opens the console in a Chromium browser this process controls
 *        (headless first when a saved profile is still signed in, otherwise a
 *        visible window), then watches that browser's cookies over the
 *        DevTools pipe and binds them the moment they pass a console check.
 *   POST /plugins/dsh-meter/login/sync-edge?family=<stepfun|mimo>
 *        Reads live cookies directly from a running Edge/Chrome browser via
 *        DevToolsActivePort (enabled once at edge://inspect/#remote-debugging)
 *        and binds or refreshes the console session without re-logging in.
 *   GET  /plugins/dsh-meter/login/status?family=...
 *        Phase of the running browser-login capture.
 *   POST /plugins/dsh-meter/login/cancel?family=...
 *        Stop watching and close the browser this plugin opened.
 *   GET  /plugins/dsh-meter/providers?probe=1&force=1
 *        Lists configured providers with detected or assigned quota families.
 *   POST /plugins/dsh-meter/gateways
 *        Assigns or clears a provider's Sub2API / New API gateway family.
 *   GET  /plugins/dsh-meter/hmr
 *        Ask the client module system to republish this package's browser
 *        bundle; the page's HMR receiver then re-materializes it in place.
 *   GET  /plugins/dsh-meter/raw?family=...
 *        Read-only passthrough of one plan's raw usage payload (no secrets),
 *        used to confirm that a column means "used" and not "remaining".
 *   GET  /plugins/dsh-meter/log?kind=&detail=
 *        Sink for the browser half's best-effort reports (see /status).
 *
 * Responses never contain a secret: only percentages, reset times, and
 * short text windows.
 */

import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROUTE_PREFIX = '/plugins/dsh-meter'
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const OK_TTL_MS = 60_000
const ERROR_TTL_MS = 20_000
const LOG_LIMIT = 80
/** Rolling buffer of client-half reports, readable from /status. */
const CLIENT_LOG = []

// ── helpers ───────────────────────────────────────────────────────────

let credentialRefFn = null
let credentialRefResolved = false
async function ensureCredentialRef() {
  if (credentialRefResolved) return
  credentialRefResolved = true
  try {
    const mod = await import('@deepseek-ai/dsh-credentials')
    if (typeof mod.credentialRef === 'function') credentialRefFn = mod.credentialRef
  } catch {
    // Missing peer: env-only resolution still works.
  }
}
const ref = (name) => (credentialRefFn !== null ? credentialRefFn(name) : name)

/**
 * Clamp an already-percentage value into 0..100.
 * Every adapter normalizes its own units before calling this (MiniMax and Kimi
 * derive percentages from counts, MiMo scales 0..1 fractions itself), so a
 * literal "1" here means one percent and must not be rescaled.
 */
function clampPct(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.min(100, Math.round(n * 10) / 10)
}

function normalizeResetAt(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    // Numeric strings are epoch seconds/millis; `Date.parse("0")` would happily
    // return the year 2000, so parse digits as numbers first.
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const n = Number(trimmed)
      if (!Number.isFinite(n) || n <= 0) return null
      return new Date(n > 1e12 ? n : n * 1000).toISOString()
    }
    const ms = Date.parse(trimmed)
    return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null
  }
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  return new Date(n > 1e12 ? n : n * 1000).toISOString()
}

function percentWindow(key, percent, resetsAt) {
  const pct = clampPct(percent)
  if (pct === null) return null
  return { key, percent: pct, resetsAt: normalizeResetAt(resetsAt) }
}

function textWindow(key, text) {
  const s = typeof text === 'string' ? text.trim() : ''
  return s.length > 0 ? { key, percent: null, resetsAt: null, text: s } : null
}

/** Currency symbol for a wallet amount; an unknown currency keeps its code. */
function currencySymbol(currency) {
  const code = String(currency ?? '').toUpperCase()
  if (code === 'CNY') return '¥'
  if (code === 'USD') return '$'
  return code.length > 0 ? `${code} ` : ''
}

/**
 * Render a wallet amount the way a console headline would: two decimals, and
 * `<¥0.01` for a sub-cent remainder that would otherwise read as zero.
 */
function moneyText(value, currency) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  const symbol = currencySymbol(currency)
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  if (abs > 0 && abs < 0.01) return `${sign}<${symbol}0.01`
  return `${sign}${symbol}${abs.toFixed(2)}`
}

/** One text-only row: a wallet balance is money, not a percentage of a window. */
function moneyWindow(key, value, currency) {
  const text = moneyText(value, currency)
  return text === null ? null : textWindow(key, text)
}

/** Pick the wallet to report: CNY when several currencies exist, else the first. */
function preferredWallet(wallets) {
  const list = Array.isArray(wallets)
    ? wallets.filter((wallet) => wallet !== null && typeof wallet === 'object')
    : []
  return list.find((wallet) => String(wallet.currency ?? '').toUpperCase() === 'CNY') ?? list[0] ?? null
}

/**
 * Balance rows for one wallet pair: the usable total plus the granted slice
 * when it is non-zero. The two official DeepSeek routes are pay-as-you-go, so
 * no percentage window exists and the badge reads the remaining amount instead.
 */
function balanceWindows({ total, granted, currency }) {
  const windows = []
  const totalWindow = moneyWindow('balance', total, currency)
  if (totalWindow !== null) windows.push(totalWindow)
  const grantedValue = Number(granted)
  if (Number.isFinite(grantedValue) && grantedValue > 0) {
    const bonusWindow = moneyWindow('bonus', granted, currency)
    if (bonusWindow !== null) windows.push(bonusWindow)
  }
  return windows
}

/** The account route reports normal + bonus wallets; the badge shows their sum. */
function deepseekAccountWindows(balance) {
  const normals = Array.isArray(balance?.value) ? balance.value : []
  const bonuses = Array.isArray(balance?.bonusWallets) ? balance.bonusWallets : []
  const currency = preferredWallet(normals)?.currency ?? preferredWallet(bonuses)?.currency ?? 'CNY'
  const walletCode = String(currency).toUpperCase()
  const sum = (wallets) => wallets
    .filter((wallet) => wallet !== null && typeof wallet === 'object'
      && String(wallet.currency ?? '').toUpperCase() === walletCode)
    .reduce((total, wallet) => total + (Number(wallet.balance) || 0), 0)
  const granted = sum(bonuses)
  return balanceWindows({ total: sum(normals) + granted, granted, currency })
}

/** The API-key route reports one summary row per currency. */
function deepseekOfficialWindows(data) {
  const wallet = preferredWallet(data?.balance_infos)
  if (wallet === null) return []
  return balanceWindows({
    total: wallet.total_balance,
    granted: wallet.granted_balance,
    currency: wallet.currency,
  })
}

async function fetchJson(url, { method = 'GET', headers = {}, body, timeoutMs = 12_000, attempts = 3 } = {}) {
  let response = null
  for (let attempt = 1; ; attempt += 1) {
    try {
      response = await fetch(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
      break
    } catch (error) {
      if (attempt >= attempts) throw error
      await new Promise((resolve) => setTimeout(resolve, 700 * attempt))
    }
  }
  const text = await response.text()
  let data = null
  try {
    data = text.length > 0 ? JSON.parse(text) : null
  } catch {
    data = null
  }
  return { status: response.status, ok: response.ok, data }
}

function httpError(status, message) {
  const error = new Error(message)
  error.httpStatus = status
  return error
}

/** A console answer that means "this session is no longer signed in". */
function expiredError(message) {
  const error = httpError(502, message)
  error.authExpired = true
  return error
}

// ── provider routing ──────────────────────────────────────────────────

function isLlmPiAiRow(row) {
  const candidates = [
    row?.entry?.name,
    row?.entry?.id,
    row?.entry?.moduleName,
    row?.entry?.patchId,
    row?.patchId,
  ].filter((value) => typeof value === 'string')
  return candidates.some((value) => value === '@deepseek-ai/dsh-llm-pi-ai' || value === 'llm-pi-ai' || value === 'include:llm-pi-ai' || value.endsWith('dsh-llm-pi-ai'))
}

function readProviderRows(ctx) {
  const editor = ctx.get('configEditor')
  if (editor === undefined || typeof editor.configuration !== 'function') return {}
  try {
    for (const row of editor.configuration()) {
      if (!isLlmPiAiRow(row)) continue
      const inherited = row.inherited?.providers ?? {}
      const override = row.override?.providers ?? {}
      const keys = new Set([...Object.keys(inherited), ...Object.keys(override)])
      if (keys.size > 0) {
        const merged = {}
        for (const key of keys) {
          if (override[key] === null) continue
          const a = inherited[key]
          const b = override[key]
          merged[key] = {
            ...(a !== null && typeof a === 'object' ? a : {}),
            ...(b !== null && typeof b === 'object' ? b : {}),
          }
        }
        if (Object.keys(merged).length > 0) return merged
      }
      const direct = row?.entry?.config?.providers ?? row?.config?.providers
      if (direct !== null && typeof direct === 'object') return direct
    }
  } catch {
    // Config surface unavailable: conventional env names still apply.
  }
  return {}
}

function configEditorDiagnostics(ctx) {
  const out = { present: false }
  const editor = ctx.get('configEditor')
  if (editor === undefined) return out
  out.present = true
  out.hasConfiguration = typeof editor.configuration === 'function'
  if (!out.hasConfiguration) return out
  try {
    const rows = editor.configuration()
    out.rowCount = Array.isArray(rows) ? rows.length : -1
    const target = (Array.isArray(rows) ? rows : []).find((row) => isLlmPiAiRow(row))
    if (target !== undefined) {
      out.found = true
      out.entryKeys = target.entry !== null && typeof target.entry === 'object' ? Object.keys(target.entry) : []
      out.entrySample = {
        id: target.entry?.id ?? null,
        name: target.entry?.name ?? null,
        moduleName: target.entry?.moduleName ?? null,
        patchId: target.entry?.patchId ?? null,
      }
      out.providerKeys = {
        inherited: Object.keys(target.inherited?.providers ?? {}),
        override: Object.keys(target.override?.providers ?? {}),
        entryConfig: typeof target.entry?.config === 'object' && target.entry?.config !== null
          ? Object.keys(target.entry.config)
          : null,
      }
    }
  } catch (error) {
    out.error = String(error?.message ?? error)
  }
  return out
}

/**
 * Read the official API-key route's settings (endpoint and credential name)
 * from the `llm-deepseek` configuration entry. Both fields are optional and
 * fall back to the shipped defaults.
 */
function readDeepseekRoute(ctx) {
  const out = {}
  const editor = ctx.get('configEditor')
  if (editor === undefined || typeof editor.configuration !== 'function') return out
  try {
    for (const row of editor.configuration()) {
      const id = row?.entry?.id
      const moduleName = String(row?.entry?.name ?? row?.entry?.moduleName ?? '')
      const isRoute = id === 'llm-deepseek' || moduleName.endsWith('dsh-llm-deepseek-api-key')
      if (!isRoute) continue
      const layers = [row?.inherited, row?.override, row?.entry?.config, row?.config]
      for (const layer of layers) {
        if (layer === null || typeof layer !== 'object') continue
        if (out.baseURL === undefined && typeof layer.baseURL === 'string' && layer.baseURL.trim().length > 0) {
          out.baseURL = layer.baseURL.trim()
        }
        if (out.apiKeyEnv === undefined && typeof layer.apiKeyEnv === 'string' && layer.apiKeyEnv.trim().length > 0) {
          out.apiKeyEnv = layer.apiKeyEnv.trim()
        }
      }
      break
    }
  } catch {
    // Config surface unavailable: the shipped defaults still apply.
  }
  return out
}

const OFFICIAL_FIRST_PARTY_DOMAINS = [
  'openai.com',
  'anthropic.com',
  'googleapis.com',
  'deepseek.com',
  'moonshot.cn',
  'moonshot.ai',
  'kimi.com',
  'minimax.chat',
  'minimax.io',
  'minimaxi.com',
  'minimax.cn',
  'opencode.ai',
  'stepfun.com',
  'xiaomimimo.com',
  'xiaomi.com',
  'mi.com',
  'aliyuncs.com',
  'openrouter.ai',
  'siliconflow.cn',
  'siliconflow.com',
  'groq.com',
  'x.ai',
  'together.xyz',
  'fireworks.ai',
  'bigmodel.cn',
  'volces.com',
]

/** Normalize a self-hosted gateway baseURL to its root origin+prefix without trailing `/v1`. */
function gatewayRootUrl(baseURL) {
  const trimmed = String(baseURL ?? '').trim().replace(/\/+$/, '')
  if (trimmed.length === 0) return null
  const stripped = trimmed.replace(/\/v1$/i, '')
  try {
    const parsed = new URL(stripped)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '')
  } catch {
    return null
  }
}

function isOfficialFirstPartyUrl(baseURL) {
  const root = gatewayRootUrl(baseURL)
  if (root === null) return false
  try {
    const host = new URL(root).hostname.toLowerCase()
    return OFFICIAL_FIRST_PARTY_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))
  } catch {
    return false
  }
}

function conventionalEnvName(provider) {
  const clean = String(provider ?? '').trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase()
  return clean.length > 0 ? `${clean}_API_KEY` : ''
}

function meterDataDir(config) {
  return typeof config?.dataDir === 'string' && config.dataDir.trim().length > 0
    ? config.dataDir.trim()
    : path.join(os.homedir(), '.dsh', 'dsh-meter')
}

function gatewaysFileFor(dataDir) {
  return path.join(dataDir, 'gateways.json')
}

function loadGatewayMap(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(gatewaysFileFor(dataDir), 'utf8'))
    const providers = raw?.providers
    if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) return {}
    const out = {}
    for (const [key, value] of Object.entries(providers)) {
      if (value === 'sub2api' || value === 'new-api' || value === 'none') out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

function saveGatewayMap(dataDir, map) {
  fs.mkdirSync(dataDir, { recursive: true })
  const clean = {}
  for (const [key, value] of Object.entries(map ?? {})) {
    if (value === 'sub2api' || value === 'new-api' || value === 'none') clean[key] = value
  }
  fs.writeFileSync(gatewaysFileFor(dataDir), JSON.stringify({ providers: clean }, null, 2), 'utf8')
}

function detectFamily(ns, baseURL) {
  const name = String(ns ?? '').trim().toLowerCase()
  // The two official DeepSeek routes serve the same models, so only the
  // provider id can tell them apart; a baseURL match would be ambiguous.
  if (name === 'deepseek-account') return 'deepseek-account'
  if (name === 'deepseek-official' || name === 'deepseek') return 'deepseek-official'
  const s = `${ns ?? ''} ${baseURL ?? ''}`.toLowerCase()
  // Self-hosted gateways are recognized by their deployment URL; there is no
  // fixed canonical host.
  if (s.includes('sub2api')) return 'sub2api'
  if (s.includes('new-api') || s.includes('newapi') || s.includes('one-api') || s.includes('oneapi') || s.includes('voapi') || s.includes('veloera')) return 'new-api'
  if (s.includes('stepfun')) return 'stepfun'
  // Every Xiaomi route (console MiMo, `xiaomi`, `xiaomi-token-plan-cn|ams|sgp`)
  // reports through the same MiMo console plan.
  if (s.includes('mimo') || s.includes('xiaomi')) return 'mimo'
  if (s.includes('kimi') || s.includes('moonshot')) return 'kimi'
  if (s.includes('minimax')) return 'minimax'
  if (s.includes('opencode')) return 'opencode-go'
  return null
}

const FAMILY_LABELS = {
  minimax: 'MiniMax',
  kimi: 'Kimi',
  'opencode-go': 'OpenCode Go',
  stepfun: 'StepFun',
  mimo: 'MiMo',
  sub2api: 'Sub2API',
  'new-api': 'New API',
  'deepseek-account': 'DeepSeek Account',
  'deepseek-official': 'DeepSeek',
}

const FAMILY_KEY_ENVS = {
  minimax: ['MINIMAX_CN_API_KEY', 'MINIMAX_API_KEY'],
  kimi: ['KIMI_CODING_API_KEY', 'KIMI_API_KEY'],
  'opencode-go': ['OPENCODE_GO_API_KEY', 'OPENCODEGORESPONSE_API_KEY', 'OPENCODE_GO_CHAT_API_KEY'],
  stepfun: ['STEPFUN_COOKIE'],
  mimo: ['MIMO_COOKIE', 'XIAOMI_MIMO_COOKIE'],
  // The provider row's own apiKeyEnv wins; these are only conventional fallbacks.
  sub2api: ['SUB2API_API_KEY'],
  'new-api': ['NEW_API_KEY', 'NEWAPI_API_KEY', 'ONE_API_KEY', 'ONEAPI_API_KEY'],
  // The official API-key route defaults to DEEPSEEK_API_KEY; a settings
  // override is read from the llm-deepseek entry when it is configured.
  'deepseek-official': ['DEEPSEEK_API_KEY'],
}

const CONSOLE_TARGETS = {
  stepfun: { loginUrl: 'https://platform.stepfun.com/plan-subscribe', envName: 'STEPFUN_COOKIE', title: 'StepFun' },
  mimo: { loginUrl: 'https://platform.xiaomimimo.com/', envName: 'MIMO_COOKIE', title: '小米 MiMo' },
}

async function resolveCredential(ctx, names) {
  await ensureCredentialRef()
  const credentials = ctx.get('credentials')
  for (const name of names) {
    if (name === undefined || name === null || String(name).length === 0) continue
    if (credentials !== undefined) {
      try {
        const hit = await credentials.resolve(ref(String(name)))
        if (typeof hit?.value === 'string' && hit.value.trim().length > 0) return hit.value.trim()
      } catch {
        // Try the next candidate.
      }
    }
    const value = String(process.env[String(name)] ?? '').trim()
    if (value.length > 0) return value
  }
  return null
}

async function credentialDiagnostics(ctx) {
  const out = {}
  await ensureCredentialRef()
  out.credentialRefResolved = credentialRefFn !== null
  const credentials = ctx.get('credentials')
  out.servicePresent = credentials !== undefined && credentials !== null
  if (out.servicePresent) {
    try {
      out.describe = await credentials.describe(ref('STEPFUN_COOKIE'))
    } catch (error) {
      out.describeError = String(error?.message ?? error)
    }
  }
  return out
}

// ── browser login capture ─────────────────────────────────────────────
//
// The two console plans cannot be read with an API key, and asking a human to
// copy a Cookie header by hand is the worst part of the whole plugin. Instead
// this process launches a Chromium browser it controls, lets the human sign in
// there, and reads that browser's cookie jar over the DevTools pipe
// (`--remote-debugging-pipe`: NUL-delimited JSON-RPC on fd 3/4, no port, no
// discovery endpoint, no third-party dependency).

const LOGIN_TARGETS = {
  stepfun: {
    loginUrl: 'https://platform.stepfun.com/plan-subscribe',
    domains: ['stepfun.com'],
    label: 'StepFun',
  },
  mimo: {
    loginUrl: 'https://platform.xiaomimimo.com/',
    domains: ['xiaomimimo.com', 'xiaomi.com', 'mi.com'],
    label: 'MiMo',
  },
}

const LOGIN_POLL_MS = 2_000
const LOGIN_QUICK_MS = 15_000
const LOGIN_TIMEOUT_MS = 10 * 60_000
const LOGIN_BOUND_MARKER = '.dsh-bound'
const LOGIN_JAR_FILE = '.dsh-jar.json'
const LOGIN_SESSIONS = new Map()
// One parked headless browser per bound console family: the console page keeps
// its own session fresh, and we re-read the jar on a slow poll. Without this a
// captured cookie dies within minutes (StepFun answers "token is expired").
const KEEPALIVE = new Map()
const KEEPALIVE_MS = 120_000
// A parked page needs a few seconds to finish its own SSO/token round trip
// before the jar holds a usable token again.
const KEEPALIVE_FIRST_TICK_MS = 4_000

const BROWSER_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
]

/** ProgId → executable candidates, so the OS default browser wins when it is Chromium-based. */
const PROGID_BROWSERS = {
  MSEdgeHTM: [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  MSEdgeDHTML: ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'],
  ChromeHTML: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
  BraveHTML: [
    'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  ],
  VivaldiHTML: ['C:\\Program Files\\Vivaldi\\Application\\vivaldi.exe'],
  OperaStable: ['C:\\Program Files\\Opera\\launcher.exe'],
}

let defaultBrowserCache = null

/**
 * The OS default browser when it speaks the DevTools pipe protocol. Windows
 * keeps the `https` handler ProgId under HKCU; reading it means we open Edge
 * (the usual Windows default) instead of whatever Chromium we happen to find.
 */
function defaultBrowserExecutable() {
  if (defaultBrowserCache !== null) return defaultBrowserCache
  defaultBrowserCache = ''
  if (process.platform !== 'win32') return defaultBrowserCache
  try {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice'
    const output = execFileSync('reg.exe', ['query', key, '/v', 'ProgId'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
    const match = /ProgId\s+REG_SZ\s+(\S+)/i.exec(output)
    const progId = match?.[1] ?? ''
    for (const [prefix, candidates] of Object.entries(PROGID_BROWSERS)) {
      if (progId !== prefix) continue
      for (const candidate of candidates) {
        try {
          if (fs.statSync(candidate).isFile()) {
            defaultBrowserCache = candidate
            return defaultBrowserCache
          }
        } catch { /* try the next install location */ }
      }
    }
  } catch {
    // Registry unavailable: fall through to the fixed candidate list.
  }
  return defaultBrowserCache
}

function findBrowser() {
  const override = process.env.DSH_QUOTA_BROWSER
  if (typeof override === 'string' && override.length > 0) {
    try {
      if (fs.statSync(override).isFile()) return override
    } catch { /* fall through */ }
  }
  const preferred = defaultBrowserExecutable()
  if (preferred !== '') return preferred
  for (const candidate of BROWSER_CANDIDATES) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      // Next candidate.
    }
  }
  return null
}

function profileDirFor(family, dataDir = meterDataDir()) {
  return path.join(dataDir, 'browser-profiles', family)
}

/**
 * A profile only gets the silent (headless) pass once it has bound a cookie
 * before; a brand-new or signed-out profile would otherwise burn the whole
 * quick deadline before the login window even appears.
 */
function profileLooksBound(dir) {
  return fs.existsSync(path.join(dir, LOGIN_BOUND_MARKER))
}

function markProfileBound(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, LOGIN_BOUND_MARKER), new Date().toISOString(), 'utf8')
  } catch { /* the marker is only an optimization */ }
}

// ── session-cookie resurrection ───────────────────────────────────────
//
// Chromium never persists session cookies, and a kill can also lose pending
// writes. The consoles' long-lived credential (e.g. the StepFun SSO session on
// account.stepfun.com) is exactly such a cookie, so a restarted profile is
// always signed out even though the server-side session is still warm. We keep
// a copy of the filtered jar (with domains) next to the profile and re-seed it
// into every browser we open, which resurrects the dropped session cookies.

function slimCookies(cookies) {
  const out = []
  for (const cookie of cookies ?? []) {
    if (cookie === null || typeof cookie !== 'object') continue
    if (typeof cookie.name !== 'string' || cookie.name.length === 0) continue
    out.push({
      name: cookie.name,
      value: String(cookie.value ?? ''),
      domain: String(cookie.domain ?? ''),
      path: cookie.path ?? '/',
      secure: cookie.secure === true,
      httpOnly: cookie.httpOnly === true,
      ...(['Strict', 'Lax', 'None'].includes(cookie.sameSite) ? { sameSite: cookie.sameSite } : {}),
      ...(typeof cookie.expires === 'number' && cookie.expires > 0 ? { expires: cookie.expires } : {}),
    })
  }
  return out
}

function loadJarCookies(profileDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(profileDir, LOGIN_JAR_FILE), 'utf8'))
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

function persistJarCookies(profileDir, cookies) {
  try {
    fs.mkdirSync(profileDir, { recursive: true })
    fs.writeFileSync(path.join(profileDir, LOGIN_JAR_FILE), JSON.stringify(slimCookies(cookies)), 'utf8')
  } catch { /* the jar file is only an optimization */ }
}

/** Rebuild cookie objects from a stored `name=value; …` header on the family domains. */
function headerCookiesFor(family, header) {
  const domains = LOGIN_TARGETS[family]?.domains ?? []
  const out = []
  const seen = new Set()
  for (const part of String(header ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const name = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (name.length === 0) continue
    for (const domain of domains) {
      const key = `${domain}${name}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ name, value, domain: `.${domain}`, path: '/' })
    }
  }
  return out
}

function resurrectCookiesFor(family, profileDir, storedHeader) {
  const jar = loadJarCookies(profileDir)
  return jar.length > 0 ? jar : headerCookiesFor(family, storedHeader)
}

function mergeCookieLists(baseCookies, extraCookies) {
  const merged = new Map()
  for (const cookie of slimCookies(baseCookies)) {
    merged.set(`${cookie.domain.toLowerCase()}\u0000${cookie.name}`, cookie)
  }
  for (const cookie of slimCookies(extraCookies)) {
    merged.set(`${cookie.domain.toLowerCase()}\u0000${cookie.name}`, cookie)
  }
  return [...merged.values()]
}

function devToolsPortCandidates(config) {
  if (typeof config?.edgeUserDataDir === 'string') {
    const customDir = config.edgeUserDataDir.trim()
    return customDir.length > 0
      ? [{ browser: 'Microsoft Edge', file: path.join(customDir, 'DevToolsActivePort') }]
      : []
  }
  const candidates = []
  const envDir = String(process.env.DSH_EDGE_USER_DATA_DIR ?? '').trim()
  if (envDir.length > 0) {
    candidates.push({ browser: 'Microsoft Edge', file: path.join(envDir, 'DevToolsActivePort') })
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    candidates.push(
      { browser: 'Microsoft Edge', file: path.join(localAppData, 'Microsoft', 'Edge', 'User Data', 'DevToolsActivePort') },
      { browser: 'Microsoft Edge Beta', file: path.join(localAppData, 'Microsoft', 'Edge Beta', 'User Data', 'DevToolsActivePort') },
      { browser: 'Microsoft Edge Dev', file: path.join(localAppData, 'Microsoft', 'Edge Dev', 'User Data', 'DevToolsActivePort') },
      { browser: 'Google Chrome', file: path.join(localAppData, 'Google', 'Chrome', 'User Data', 'DevToolsActivePort') },
    )
  } else if (process.platform === 'darwin') {
    const appSupport = path.join(os.homedir(), 'Library', 'Application Support')
    candidates.push(
      { browser: 'Microsoft Edge', file: path.join(appSupport, 'Microsoft Edge', 'DevToolsActivePort') },
      { browser: 'Google Chrome', file: path.join(appSupport, 'Google', 'Chrome', 'DevToolsActivePort') },
    )
  } else {
    const cfgDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
    candidates.push(
      { browser: 'Microsoft Edge', file: path.join(cfgDir, 'microsoft-edge', 'DevToolsActivePort') },
      { browser: 'Google Chrome', file: path.join(cfgDir, 'google-chrome', 'DevToolsActivePort') },
    )
  }
  return candidates
}

function parseDevToolsActivePort(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    const lines = raw.trim().split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)
    if (lines.length === 0) return null
    const port = Number(lines[0])
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null
    const wsPathRaw = lines[1] ?? '/devtools/browser'
    const wsPath = wsPathRaw.startsWith('/') ? wsPathRaw : `/${wsPathRaw}`
    return { port, wsPath }
  } catch {
    return null
  }
}

async function wsCdpSession(wsUrl, timeoutMs) {
  if (typeof globalThis.WebSocket !== 'function') {
    throw new Error('global WebSocket is unavailable in this Node runtime')
  }
  return await new Promise((resolve, reject) => {
    let ws = null
    try {
      ws = new globalThis.WebSocket(wsUrl)
    } catch (error) {
      reject(error)
      return
    }
    const pending = new Map()
    let nextId = 1
    let settled = false
    let closed = false

    const failPending = (err) => {
      for (const entry of pending.values()) entry.reject(err)
      pending.clear()
    }
    const timer = setTimeout(() => {
      const err = new Error('DevTools WebSocket timed out')
      failPending(err)
      try { ws.close() } catch { /* ignore */ }
      if (!settled) { settled = true; reject(err) }
    }, timeoutMs)
    timer.unref?.()

    ws.addEventListener('open', () => {
      if (settled) return
      settled = true
      resolve({
        send(method, params = {}) {
          if (closed) return Promise.reject(new Error('DevTools WebSocket closed'))
          const id = nextId++
          return new Promise((res, rej) => {
            pending.set(id, { resolve: res, reject: rej })
            try {
              ws.send(JSON.stringify({ id, method, params }))
            } catch (error) {
              pending.delete(id)
              rej(error)
            }
          })
        },
        close() {
          closed = true
          clearTimeout(timer)
          failPending(new Error('DevTools WebSocket closed'))
          try { ws.close() } catch { /* ignore */ }
        },
      })
    })

    ws.addEventListener('message', (event) => {
      const raw = typeof event?.data === 'string'
        ? event.data
        : Buffer.isBuffer(event?.data)
          ? event.data.toString('utf8')
          : String(event?.data ?? '')
      let message = null
      try { message = JSON.parse(raw) } catch { return }
      if (message?.id === undefined) return
      const entry = pending.get(message.id)
      if (entry === undefined) return
      pending.delete(message.id)
      if (message.error !== undefined) entry.reject(new Error(`${message.error.message} (${message.error.code})`))
      else entry.resolve(message.result)
    })

    ws.addEventListener('error', (event) => {
      const err = new Error(event?.message ?? 'DevTools WebSocket connection error')
      failPending(err)
      clearTimeout(timer)
      if (!settled) { settled = true; reject(err) }
    })

    ws.addEventListener('close', () => {
      closed = true
      clearTimeout(timer)
      const err = new Error('DevTools WebSocket closed')
      failPending(err)
      if (!settled) { settled = true; reject(err) }
    })
  })
}

async function readLiveBrowserCookies(domains, { timeoutMs = 4_500, config } = {}) {
  const candidates = devToolsPortCandidates(config)
  const parsedCandidates = []
  for (const candidate of candidates) {
    const parsed = parseDevToolsActivePort(candidate.file)
    if (parsed !== null) parsedCandidates.push({ ...candidate, ...parsed })
  }
  if (parsedCandidates.length === 0) return { status: 'no-port-file' }

  let emptyMatch = null
  let lastError = null
  for (const candidate of parsedCandidates) {
    let client = null
    try {
      client = await wsCdpSession(`ws://127.0.0.1:${candidate.port}${candidate.wsPath}`, timeoutMs)
      const allCookies = []
      const defaultRes = await client.send('Storage.getCookies', {})
      if (Array.isArray(defaultRes?.cookies)) allCookies.push(...defaultRes.cookies)
      try {
        const targetsRes = await client.send('Target.getTargets', {})
        const contextIds = new Set()
        for (const info of targetsRes?.targetInfos ?? []) {
          if (typeof info?.browserContextId === 'string' && info.browserContextId.length > 0) {
            contextIds.add(info.browserContextId)
          }
        }
        for (const browserContextId of contextIds) {
          try {
            const ctxRes = await client.send('Storage.getCookies', { browserContextId })
            if (Array.isArray(ctxRes?.cookies)) allCookies.push(...ctxRes.cookies)
          } catch { /* ignore individual browser context failure */ }
        }
      } catch { /* Target.getTargets optional */ }
      const cookies = pickConsoleCookies(allCookies, domains)
      if (cookies.length > 0) return { status: 'ok', browser: candidate.browser, cookies }
      if (emptyMatch === null) emptyMatch = { status: 'ok', browser: candidate.browser, cookies: [] }
    } catch (error) {
      lastError = String(error?.message ?? error)
    } finally {
      try { client?.close() } catch { /* ignore */ }
    }
  }
  if (emptyMatch !== null) return emptyMatch
  return { status: 'connect-failed', error: lastError ?? 'connection failed' }
}

/** Minimal CDP client over `--remote-debugging-pipe`. */
function createPipeClient(child) {
  const toBrowser = child.stdio[3]
  const fromBrowser = child.stdio[4]
  const pending = new Map()
  let nextId = 1
  let buffer = ''

  fromBrowser.setEncoding('utf8')
  fromBrowser.on('data', (chunk) => {
    buffer += chunk
    for (;;) {
      const end = buffer.indexOf('\u0000')
      if (end === -1) break
      const raw = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      if (raw.length === 0) continue
      let message = null
      try { message = JSON.parse(raw) } catch { continue }
      if (message?.id === undefined) continue
      const entry = pending.get(message.id)
      if (entry === undefined) continue
      pending.delete(message.id)
      if (message.error !== undefined) entry.reject(new Error(`${message.error.message} (${message.error.code})`))
      else entry.resolve(message.result)
    }
  })
  fromBrowser.on('error', () => { /* the browser went away; pending calls time out */ })
  child.on('exit', () => {
    for (const entry of pending.values()) entry.reject(new Error('browser exited'))
    pending.clear()
  })

  return {
    send(method, params = {}, sessionId) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        const payload = { id, method, params }
        if (sessionId !== undefined) payload.sessionId = sessionId
        try {
          toBrowser.write(`${JSON.stringify(payload)}\u0000`)
        } catch (error) {
          pending.delete(id)
          reject(error)
          return
        }
        setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`${method} timed out`))
        }, 20_000)
      })
    },
  }
}

async function openBrowserPage({ headless, profileDir, url, seedCookies = [] }) {
  const browserPath = findBrowser()
  if (browserPath === null) {
    throw httpError(500, 'no Chromium browser found — install Chrome or Edge, or set DSH_QUOTA_BROWSER to its executable')
  }
  fs.mkdirSync(profileDir, { recursive: true })
  const child = spawn(browserPath, [
    '--remote-debugging-pipe',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    '--disable-sync',
    '--disable-extensions',
    '--disable-popup-blocking',
    ...(headless
      ? [
          '--headless=new',
          '--disable-background-timer-throttling',
          '--disable-renderer-backgrounding',
          '--disable-backgrounding-occluded-windows',
        ]
      : ['--window-size=1180,880', '--new-window']),
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: false })

  let cdp = null
  const stop = () => {
    // A polite Browser.close lets Chromium flush its cookie store to disk;
    // fall back to kill if the process does not exit quickly.
    try { cdp?.send('Browser.close').catch(() => {}) } catch { /* pipe already dead */ }
    const killer = setTimeout(() => { try { child.kill() } catch { /* already gone */ } }, 3_000)
    killer.unref?.()
    child.once('exit', () => clearTimeout(killer))
  }
  try {
    cdp = createPipeClient(child)
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Network.enable', {}, sessionId)
    const sanitized = slimCookies(seedCookies)
    if (sanitized.length > 0) {
      // Resurrect the session cookies Chromium dropped on exit, before the
      // console page's first request goes out.
      try { await cdp.send('Network.setCookies', { cookies: sanitized }, sessionId) } catch { /* best effort */ }
    }
    await cdp.send('Page.navigate', { url }, sessionId)
    return { cdp, sessionId, stop, browserPath }
  } catch (error) {
    stop()
    throw error
  }
}

/** Keep one cookie per name, preferring the most specific domain. */
function pickConsoleCookies(cookies, domains) {
  const picked = new Map()
  for (const cookie of cookies) {
    const host = String(cookie.domain ?? '').replace(/^\./, '').toLowerCase()
    if (!domains.some((domain) => host === domain || host.endsWith(`.${domain}`))) continue
    const current = picked.get(cookie.name)
    if (current === undefined) {
      picked.set(cookie.name, cookie)
      continue
    }
    const currentHost = String(current.domain ?? '').replace(/^\./, '').toLowerCase()
    if (host.length > currentHost.length) picked.set(cookie.name, cookie)
  }
  return [...picked.values()]
}

function cookieHeaderOf(cookies) {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
}

function loginSnapshot(session) {
  if (session === undefined) return { phase: 'idle' }
  return {
    family: session.family,
    phase: session.phase,
    message: session.message,
    lastError: session.lastError,
    cookieCount: session.cookieCount,
    browserPath: session.browserPath,
    since: session.startedAt,
    updatedAt: session.updatedAt,
  }
}

async function storeConsoleCookie(credentials, family, cookie) {
  await ensureCredentialRef()
  if (credentials !== undefined) await credentials.set(ref(CONSOLE_TARGETS[family].envName), cookie)
}

// ── parsers ───────────────────────────────────────────────────────────

function parseMiniMax(data) {
  if (data === null || typeof data !== 'object') return null
  const container = data.data !== null && typeof data.data === 'object' && !Array.isArray(data.data) ? data.data : data
  const rows = Array.isArray(data.model_remains) ? data.model_remains
    : Array.isArray(data.data?.model_remains) ? data.data.model_remains
    : null
  if (rows !== null) {
    const row = rows.find((r) => typeof r?.model_name === 'string' && (r.model_name === 'general' || r.model_name.startsWith('MiniMax-M')))
      ?? rows.find((r) => r !== null && typeof r === 'object' && (r.current_interval_remaining_percent !== undefined || r.current_interval_total_count !== undefined))
      ?? rows[0]
    const windows = windowsFromMiniMaxRow(row)
    if (windows !== null) return windows
  }
  return windowsFromMiniMaxRow(container)
}

function miniMaxCountWindow(key, used, total, remain, resetsAt) {
  const t = Number(total)
  if (Number.isFinite(t) && t > 0) {
    if (Number.isFinite(Number(used))) return percentWindow(key, (Number(used) / t) * 100, resetsAt)
    if (Number.isFinite(Number(remain))) return percentWindow(key, ((t - Number(remain)) / t) * 100, resetsAt)
  }
  return null
}

function windowsFromMiniMaxRow(row) {
  if (row === null || typeof row !== 'object') return null
  const windows = []
  const fiveHourReset = row.current_interval_reset_time ?? row.interval_reset_time ?? row.end_time
  const fiveHour = row.current_interval_remaining_percent !== undefined
    ? percentWindow('5h', 100 - Number(row.current_interval_remaining_percent), fiveHourReset)
    : miniMaxCountWindow('5h', row.current_interval_usage_count, row.current_interval_total_count, row.current_interval_remain_count, row.reset_time)
  if (fiveHour !== null) windows.push(fiveHour)
  const weeklyReset = row.weekly_reset_time ?? row.current_weekly_reset_time ?? row.weekly_end_time
  const weekly = row.current_weekly_remaining_percent !== undefined
    ? percentWindow('7d', 100 - Number(row.current_weekly_remaining_percent), weeklyReset)
    : miniMaxCountWindow('7d', row.weekly_usage_count, row.weekly_total_count, row.weekly_remain_count, row.weekly_reset_time)
  if (weekly !== null) windows.push(weekly)
  return windows.length > 0 ? windows : null
}

function kimiWindowKey(duration, timeUnit) {
  const d = Number(duration)
  if (!Number.isFinite(d)) return null
  const unit = String(timeUnit ?? '').toUpperCase()
  if (unit.startsWith('HOUR')) return d === 5 ? '5h' : `${d}h`
  if (unit.startsWith('DAY')) return d === 7 ? '7d' : d === 1 ? '1d' : `${d}d`
  if (unit.startsWith('MINUTE')) return d % 60 === 0 ? `${d / 60}h` : `${d}m`
  if (d === 300) return '5h'
  if (d === 60) return '1h'
  if (d === 1440 || d === 1) return '1d'
  if (d === 10080 || d === 7) return '7d'
  return unit.length > 0 ? `${d}${unit.slice(0, 1).toLowerCase()}` : `${d}`
}

function parseKimiUsage(data) {
  if (data === null || typeof data !== 'object') return null
  const windows = []
  const seen = new Set()
  const limits = Array.isArray(data.limits) ? data.limits : []
  for (const row of limits) {
    if (row === null || typeof row !== 'object') continue
    const detail = row.detail
    if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) continue
    const key = kimiWindowKey(row.window?.duration, row.window?.timeUnit)
    if (key === null || seen.has(key)) continue
    const total = Number(detail.limit)
    const used = Number(detail.used)
    const remain = Number(detail.remaining)
    let win = null
    if (Number.isFinite(total) && total > 0 && Number.isFinite(used)) win = percentWindow(key, (used / total) * 100, detail.resetTime)
    else if (Number.isFinite(total) && total > 0 && Number.isFinite(remain)) win = percentWindow(key, ((total - remain) / total) * 100, detail.resetTime)
    if (win !== null) { seen.add(key); windows.push(win) }
  }
  const usage = data.usage
  if (usage !== null && typeof usage === 'object' && !Array.isArray(usage)) {
    const total = Number(usage.limit)
    const used = Number(usage.used)
    const remain = Number(usage.remaining)
    let pct = null
    if (Number.isFinite(total) && total > 0 && Number.isFinite(used)) pct = (used / total) * 100
    else if (Number.isFinite(total) && total > 0 && Number.isFinite(remain)) pct = ((total - remain) / total) * 100
    if (pct !== null) {
      const win = percentWindow(seen.has('7d') ? 'week' : '7d', pct, usage.resetTime)
      if (win !== null) windows.push(win)
    }
  }
  return windows.length > 0 ? windows : null
}

function parseOpenCodeGoWindows(data) {
  const usage = data !== null && typeof data === 'object' && data.usage !== null && typeof data.usage === 'object' ? data.usage : data
  if (usage === null || typeof usage !== 'object') return null
  const windows = []
  const rolling = percentWindow('5h', usage.rolling?.percent ?? usage.rolling?.usedPercentage, usage.rolling?.resetsAt ?? usage.rolling?.resetAt)
  if (rolling !== null) windows.push(rolling)
  const weekly = percentWindow('7d', usage.weekly?.percent ?? usage.weekly?.usedPercentage, usage.weekly?.resetsAt ?? usage.weekly?.resetAt)
  if (weekly !== null) windows.push(weekly)
  const monthly = percentWindow('30d', usage.monthly?.percent ?? usage.monthly?.usedPercentage, usage.monthly?.resetsAt ?? usage.monthly?.resetAt)
  if (monthly !== null) windows.push(monthly)
  return windows.length > 0 ? windows : null
}

function parseStepfunRaw(rateData, planData) {
  if (rateData === null || typeof rateData !== 'object') throw httpError(502, 'StepFun: response is empty (not signed in?)')
  const windows = []
  const credit = rateData.plan_credit_rate_limit
  const creditLeft = Number(credit?.subscription_credit_left_rate)
  const creditMetered = credit !== null && typeof credit === 'object' && Number.isFinite(creditLeft) && creditLeft >= 0 && creditLeft <= 1
  if (creditMetered) {
    // Credit-metered plans (the Pro family) report 0 for both time windows —
    // that is "not applicable", not "exhausted" — and meter a monthly credit
    // bucket instead.
    const bucket = Array.isArray(credit.credit_buckets) ? credit.credit_buckets[0] : undefined
    const reset = bucket !== undefined && bucket.next_reset_at !== undefined && String(bucket.next_reset_at) !== '0'
      ? bucket.next_reset_at
      : (bucket?.expire_at ?? credit.subscription_credit_reset_time)
    const win = percentWindow('30d', (1 - creditLeft) * 100, reset)
    if (win !== null) windows.push(win)
  } else {
    const fiveHourLeft = Number(rateData.five_hour_usage_left_rate)
    if (Number.isFinite(fiveHourLeft)) windows.push(percentWindow('5h', (1 - fiveHourLeft) * 100, rateData.five_hour_usage_reset_time))
    const weeklyLeft = Number(rateData.weekly_usage_left_rate)
    if (Number.isFinite(weeklyLeft)) windows.push(percentWindow('7d', (1 - weeklyLeft) * 100, rateData.weekly_usage_reset_time))
    // A window-metered plan has no credit expiry of its own, so the
    // subscription end date is the extra fact worth showing.
    const expiry = normalizeResetAt(planData?.subscription?.expired_at)
    if (expiry !== null) {
      const days = Math.ceil((Date.parse(expiry) - Date.now()) / 86_400_000)
      windows.push(textWindow('plan', days >= 0 ? `${days}d` : 'expired'))
    }
  }
  if (windows.length === 0) throw httpError(502, 'StepFun: response has no usable windows')
  return windows
}

function mimoCookieUsable(cookie) {
  return /serviceToken/i.test(cookie) && /userId=/i.test(cookie)
}

/**
 * MiMo's Token Plan reports one plan-wide bucket (`plan_total_token`) plus a
 * calendar-month slice of the same limit. The console headline shows the
 * plan-wide `percent`, so that is the reading to mirror; the account cash
 * balance belongs to top-ups, not to the plan, and is deliberately not shown.
 */
function parseMimoRaw(usageData, detailData) {
  if (usageData === null || typeof usageData !== 'object') throw httpError(502, 'MiMo: response is empty (not signed in?)')
  const root = usageData.data !== null && typeof usageData.data === 'object' ? usageData.data : usageData
  const detailRoot = detailData?.data !== null && typeof detailData?.data === 'object' ? detailData.data : (detailData ?? {})
  const bucket = [root.usage, root.monthUsage].find((candidate) => candidate !== null && typeof candidate === 'object')
  if (bucket === undefined) throw httpError(502, 'MiMo: response has no usage bucket')

  let usedPercent = Number(bucket.percent)
  if (!Number.isFinite(usedPercent)) {
    const item = Array.isArray(bucket.items) ? bucket.items.find((row) => Number(row?.limit) > 0) : undefined
    const used = Number(item?.used)
    const limit = Number(item?.limit)
    usedPercent = Number.isFinite(used) && Number.isFinite(limit) && limit > 0 ? (used / limit) * 100 : Number.NaN
  }
  // The console reports a 0..1 fraction here.
  if (Number.isFinite(usedPercent) && usedPercent <= 1) usedPercent *= 100
  if (!Number.isFinite(usedPercent)) throw httpError(502, 'MiMo: usage bucket carries no percentage')

  const planCode = String(detailRoot?.planCode ?? '')
  const periodKey = /year|annual/i.test(planCode) ? '1y' : '30d'
  const periodEnd = detailRoot?.currentPeriodEnd !== undefined && detailRoot?.currentPeriodEnd !== null
    ? normalizeResetAt(`${String(detailRoot.currentPeriodEnd).replace(' ', 'T')}+08:00`)
    : null

  const win = percentWindow(periodKey, usedPercent, periodEnd)
  if (win === null) throw httpError(502, 'MiMo: response has no usable windows')
  return [win]
}

// ── live queries ──────────────────────────────────────────────────────

async function queryMinimax(key) {
  const urls = [
    'https://www.minimaxi.com/v1/token_plan/remains',
    'https://www.minimax.cn/v1/token_plan/remains',
    'https://api.minimax.io/v1/token_plan/remains',
  ]
  let lastStatus = 0
  for (const url of urls) {
    const { status, ok, data } = await fetchJson(url, { headers: { authorization: `Bearer ${key}` } })
    if (status === 401 || status === 403) throw httpError(502, `MiniMax rejected the API key (HTTP ${status})`)
    if (!ok) { lastStatus = status; continue }
    const windows = parseMiniMax(data)
    if (windows !== null) return windows
  }
  throw httpError(502, `MiniMax quota endpoint failed (HTTP ${lastStatus || 'network'})`)
}

async function queryKimi(key) {
  const bases = ['https://api.kimi.com/coding/v1/usages', 'https://api.kimi.com/coding/v1/usage']
  let lastStatus = 0
  for (const url of bases) {
    const { status, ok, data } = await fetchJson(url, { headers: { authorization: `Bearer ${key}` } })
    if (status === 401 || status === 403) throw httpError(502, `Kimi rejected the API key (HTTP ${status})`)
    if (status === 404) { lastStatus = 404; continue }
    if (!ok) { lastStatus = status; continue }
    const windows = parseKimiUsage(data)
    if (windows !== null) return windows
  }
  throw httpError(502, `Kimi usage endpoint failed (HTTP ${lastStatus || 'network'})`)
}

async function queryOpenCodeGo(key) {
  const { status, ok, data } = await fetchJson('https://opencode.ai/zen/go/v1/usage', {
    headers: { authorization: `Bearer ${key}`, 'user-agent': BROWSER_UA },
  })
  if (status === 401 || status === 403) throw httpError(502, `OpenCode Go rejected the API key (HTTP ${status}); no subscription on this key?`)
  if (!ok) throw httpError(502, `OpenCode Go usage endpoint failed (HTTP ${status})`)
  const windows = parseOpenCodeGoWindows(data)
  if (windows === null) throw httpError(502, 'OpenCode Go usage response has no usable windows')
  return windows
}

async function queryStepfun(cookie) {
  const base = 'https://platform.stepfun.com/api/step.openapi.devcenter.Dashboard'
  const oasisWebid = /Oasis-Webid=([^;]+)/i.exec(cookie)?.[1] ?? ''
  const headers = {
    accept: '*/*',
    'content-type': 'application/json',
    'oasis-appid': '10300',
    'oasis-platform': 'web',
    'oasis-webid': decodeURIComponent(oasisWebid),
    origin: 'https://platform.stepfun.com',
    referer: 'https://platform.stepfun.com/plan-subscribe',
    'user-agent': BROWSER_UA,
    cookie,
  }
  const [rate, plan] = await Promise.all([
    fetchJson(`${base}/QueryStepPlanRateLimit`, { method: 'POST', headers, body: '{}' }),
    fetchJson(`${base}/GetStepPlanStatus`, { method: 'POST', headers, body: '{}' }).catch(() => null),
  ])
  if (rate.status === 401 || rate.status === 403) throw expiredError(`StepFun console rejected the saved session (HTTP ${rate.status}) — sign in again`)
  if (!rate.ok) throw httpError(502, `StepFun rate-limit endpoint failed (HTTP ${rate.status || 'network'})`)
  return parseStepfunRaw(rate.data, plan?.data)
}

async function queryMimo(cookie) {
  const base = 'https://platform.xiaomimimo.com/api/v1'
  const headers = { accept: 'application/json', 'user-agent': BROWSER_UA, cookie }
  const [usage, detail] = await Promise.all([
    fetchJson(`${base}/tokenPlan/usage`, { headers }),
    fetchJson(`${base}/tokenPlan/detail`, { headers }).catch(() => null),
  ])
  if (usage.status === 401 || usage.status === 403) throw expiredError(`MiMo console rejected the saved session (HTTP ${usage.status}) — sign in again`)
  if (!usage.ok || usage.data === null || typeof usage.data !== 'object') {
    throw httpError(502, `MiMo usage endpoint failed (HTTP ${usage.status || 'network'})`)
  }
  return parseMimoRaw(usage.data, detail?.data)
}

// ── sub2api ───────────────────────────────────────────────────────────
//
// Wei-Shaw/sub2api gateways answer `GET {base}/v1/usage` (Bearer API key) in
// one of four mutually exclusive shapes: a `subscription` object with daily /
// weekly / monthly USD windows, a total `quota`, `rate_limits` entries with
// reset times, or a plain wallet `balance` (optionally with a `daily_usage`
// breakdown).

function sub2apiUsageUrl(baseURL) {
  const root = gatewayRootUrl(baseURL)
  return root === null ? null : `${root}/v1/usage`
}

function sub2apiQuotaWindow(key, used, limit, resetsAt) {
  const l = Number(limit)
  if (!Number.isFinite(l) || l <= 0) return null
  const u = Number(used)
  return percentWindow(key, ((Number.isFinite(u) ? u : 0) / l) * 100, resetsAt)
}

function sub2apiWindows(data) {
  if (data === null || typeof data !== 'object') return null
  const unit = data.unit ?? data.currency ?? ''
  const windows = []
  const sub = data.subscription
  if (sub !== null && typeof sub === 'object') {
    windows.push(
      sub2apiQuotaWindow('1d', sub.daily_usage_usd, sub.daily_limit_usd),
      sub2apiQuotaWindow('7d', sub.weekly_usage_usd, sub.weekly_limit_usd),
      sub2apiQuotaWindow('30d', sub.monthly_usage_usd, sub.monthly_limit_usd),
    )
  }
  const quota = data.quota
  if (quota !== null && typeof quota === 'object') {
    windows.push(sub2apiQuotaWindow('quota', quota.used, quota.limit))
  }
  if (Array.isArray(data.rate_limits)) {
    for (const [index, rl] of data.rate_limits.entries()) {
      if (rl === null || typeof rl !== 'object') continue
      const key = String(rl.window ?? rl.name ?? `rate${index}`)
      windows.push(sub2apiQuotaWindow(key, rl.used, rl.limit, rl.reset_at ?? rl.resets_at))
    }
  }
  const balance = Number(data.balance ?? data.wallet?.balance)
  if (Number.isFinite(balance)) windows.push(moneyWindow('balance', balance, unit))
  if (Array.isArray(data.daily_usage)) {
    const today = new Date().toISOString().slice(0, 10)
    const row = data.daily_usage.find((r) => String(r?.date ?? '') === today)
    const spend = Number(row?.actual_cost ?? row?.cost)
    if (Number.isFinite(spend)) windows.push(textWindow('today', String(moneyText(spend, unit) ?? spend)))
  }
  if (typeof data.planName === 'string' && data.planName.trim().length > 0) {
    windows.push(textWindow('plan', data.planName))
  }
  const kept = windows.filter((window) => window !== null)
  return kept.length > 0 ? kept : null
}

async function querySub2api(key, baseURL) {
  const url = sub2apiUsageUrl(baseURL)
  if (url === null) throw httpError(502, 'sub2api provider has no baseURL configured')
  const { status, ok, data } = await fetchJson(url, {
    headers: { authorization: `Bearer ${key}`, accept: 'application/json', 'user-agent': BROWSER_UA },
  })
  if (status === 401 || status === 403) throw httpError(502, `sub2api rejected the API key (HTTP ${status})`)
  if (!ok) throw httpError(502, `sub2api usage endpoint failed (HTTP ${status || 'network'})`)
  const windows = sub2apiWindows(data)
  if (windows === null) throw httpError(502, 'sub2api usage response has no usable windows')
  return windows
}

// ── new-api / one-api ─────────────────────────────────────────────────
//
// QuantumNous/new-api and songquanpeng/one-api gateways expose:
//   GET /api/status                         -> { data: { quota_per_unit } }
//   GET /api/usage/token/                   -> { data: { object: "token_usage", total_granted, total_used, total_available, unlimited_quota, expires_at } }
//   GET /v1/dashboard/billing/subscription  -> { object: "billing_subscription", hard_limit_usd, soft_limit_usd }
//   GET /v1/dashboard/billing/usage         -> { total_usage (in cents) }

const NEW_API_DEFAULT_QUOTA_PER_UNIT = 500_000
const NEW_API_STATUS_TTL_MS = 10 * 60_000

function newApiBillingDateRange() {
  const now = Date.now()
  const start = new Date(now - 99 * 86_400_000).toISOString().slice(0, 10)
  const end = new Date(now + 86_400_000).toISOString().slice(0, 10)
  return { startDate: start, endDate: end }
}

function parseNewApiWindows({ tokenPayload, subPayload, usagePayload, quotaPerUnit = NEW_API_DEFAULT_QUOTA_PER_UNIT }) {
  const rate = Number.isFinite(Number(quotaPerUnit)) && Number(quotaPerUnit) > 0
    ? Number(quotaPerUnit)
    : NEW_API_DEFAULT_QUOTA_PER_UNIT
  const tokenData = tokenPayload?.data && typeof tokenPayload.data === 'object'
    ? tokenPayload.data
    : (tokenPayload && tokenPayload.object === 'token_usage' ? tokenPayload : null)
  const subData = subPayload && typeof subPayload === 'object' ? subPayload : null
  const windows = []

  if (tokenData?.object === 'token_usage' && tokenData.unlimited_quota === false && Number(tokenData.total_granted) > 0) {
    const granted = Number(tokenData.total_granted)
    const used = Number.isFinite(Number(tokenData.total_used)) ? Number(tokenData.total_used) : 0
    const avail = Number.isFinite(Number(tokenData.total_available))
      ? Number(tokenData.total_available)
      : Math.max(0, granted - used)
    const expiresAt = Number(tokenData.expires_at) > 0 ? Number(tokenData.expires_at) : null
    const quotaWin = percentWindow('quota', (used / granted) * 100, expiresAt)
    if (quotaWin !== null) windows.push(quotaWin)
    const balWin = moneyWindow('balance', Math.max(0, avail) / rate, 'USD')
    if (balWin !== null) windows.push(balWin)
  } else if (subData !== null && (subData.object === 'billing_subscription' || Number.isFinite(Number(subData.hard_limit_usd)))) {
    const limitUsd = Number(subData.hard_limit_usd ?? subData.soft_limit_usd)
    const usedUsd = Number.isFinite(Number(usagePayload?.total_usage))
      ? Number(usagePayload.total_usage) / 100
      : Number.isFinite(Number(tokenData?.total_used))
        ? Number(tokenData.total_used) / rate
        : 0
    if (Number.isFinite(limitUsd) && limitUsd > 0 && limitUsd < 10_000_000) {
      const remainUsd = Math.max(0, limitUsd - usedUsd)
      const balWin = moneyWindow('balance', remainUsd, 'USD')
      if (balWin !== null) windows.push(balWin)
    } else {
      const infWin = textWindow('balance', '∞')
      if (infWin !== null) windows.push(infWin)
    }
    if (usedUsd > 0) {
      const usedWin = moneyWindow('used', usedUsd, 'USD')
      if (usedWin !== null) windows.push(usedWin)
    }
  } else if (tokenData?.object === 'token_usage' && tokenData.unlimited_quota === true) {
    const infWin = textWindow('balance', '∞')
    if (infWin !== null) windows.push(infWin)
    const usedUsd = Number.isFinite(Number(tokenData.total_used)) ? Number(tokenData.total_used) / rate : 0
    if (usedUsd > 0) {
      const usedWin = moneyWindow('used', usedUsd, 'USD')
      if (usedWin !== null) windows.push(usedWin)
    }
  }

  return windows.length > 0 ? windows : null
}

async function fetchNewApiQuotaPerUnit(root, statusCache) {
  const hit = statusCache?.get(root)
  if (hit !== undefined && Date.now() - hit.at < NEW_API_STATUS_TTL_MS) return hit.quotaPerUnit
  let quotaPerUnit = NEW_API_DEFAULT_QUOTA_PER_UNIT
  try {
    const { ok, data } = await fetchJson(`${root}/api/status`, {
      headers: { accept: 'application/json', 'user-agent': BROWSER_UA },
      timeoutMs: 5_000,
      attempts: 1,
    })
    const candidate = Number(data?.data?.quota_per_unit)
    if (ok && Number.isFinite(candidate) && candidate > 0) quotaPerUnit = candidate
  } catch { /* fall back to default conversion rate */ }
  statusCache?.set(root, { quotaPerUnit, at: Date.now() })
  return quotaPerUnit
}

async function fetchNewApiTokenUsage(root, headers) {
  const first = await fetchJson(`${root}/api/usage/token/`, { headers }).catch(() => ({ status: 0, ok: false, data: null }))
  if (first.status !== 404) return first
  return fetchJson(`${root}/api/usage/token`, { headers }).catch(() => ({ status: 0, ok: false, data: null }))
}

async function queryNewApi(key, baseURL, statusCache) {
  const root = gatewayRootUrl(baseURL)
  if (root === null) throw httpError(502, 'New API provider has no baseURL configured')
  const headers = { authorization: `Bearer ${key}`, accept: 'application/json', 'user-agent': BROWSER_UA }
  const { startDate, endDate } = newApiBillingDateRange()
  const [quotaPerUnit, tokenRes, subRes, usageRes] = await Promise.all([
    fetchNewApiQuotaPerUnit(root, statusCache),
    fetchNewApiTokenUsage(root, headers),
    fetchJson(`${root}/v1/dashboard/billing/subscription`, { headers }).catch(() => ({ status: 0, ok: false, data: null })),
    fetchJson(`${root}/v1/dashboard/billing/usage?start_date=${startDate}&end_date=${endDate}`, { headers }).catch(() => ({ status: 0, ok: false, data: null })),
  ])
  const windows = parseNewApiWindows({
    tokenPayload: tokenRes.ok ? tokenRes.data : null,
    subPayload: subRes.ok ? subRes.data : null,
    usagePayload: usageRes.ok ? usageRes.data : null,
    quotaPerUnit,
  })
  if (windows !== null) return windows
  const authFailed = [tokenRes, subRes].find((res) => (res.status === 401 || res.status === 403))
  if (authFailed !== undefined && !tokenRes.ok && !subRes.ok) {
    throw httpError(502, `New API rejected the API key (HTTP ${authFailed.status})`)
  }
  const errStatus = [tokenRes, subRes].find((res) => !res.ok && res.status > 0)?.status ?? 0
  if (!tokenRes.ok && !subRes.ok) {
    throw httpError(502, `New API usage endpoint failed (HTTP ${errStatus || 'network'})`)
  }
  throw httpError(502, 'New API usage response has no usable windows')
}

/** The open platform origin whose `/user/balance` bills this API key. */
function deepseekOfficialOrigin(route = {}) {
  const configured = String(route.baseURL ?? process.env.DEEPSEEK_BASE_URL ?? '').trim()
  if (configured.length > 0) {
    try {
      return new URL(configured).origin
    } catch {
      // Fall through to the public origin.
    }
  }
  return 'https://api.deepseek.com'
}

/**
 * The API-key route is balance-metered: `GET /user/balance` is the only public
 * quota endpoint, so the meter reports the remaining money, not a percentage.
 */
async function queryDeepSeekOfficial(key, route = {}) {
  const { status, ok, data } = await fetchJson(`${deepseekOfficialOrigin(route)}/user/balance`, {
    headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
  })
  if (status === 401 || status === 403) throw httpError(502, `DeepSeek rejected the API key (HTTP ${status})`)
  if (!ok) throw httpError(502, `DeepSeek balance endpoint failed (HTTP ${status || 'network'})`)
  const windows = deepseekOfficialWindows(data)
  if (windows.length === 0) throw httpError(502, 'DeepSeek balance response carries no wallet')
  return windows
}

/** Client identity the DeepSeek account service forwards to the platform. */
function dshClientVersion(ctx) {
  try {
    const release = ctx.get('clientModules')?.release
    if (release !== null && typeof release === 'object'
      && typeof release.version === 'string' && release.version.length > 0) return release.version
  } catch {
    // Older compositions may not expose the client module registry.
  }
  const fromEnv = String(process.env.DSH_CLIENT_VERSION ?? '').trim()
  return fromEnv.length > 0 ? fromEnv : '0.0.0'
}

function accountClientMetadata(ctx) {
  return {
    version: dshClientVersion(ctx),
    locale: 'zh-CN',
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  }
}

// ── plugin ────────────────────────────────────────────────────────────

export function apply(ctx, config = {}) {
  const dataDir = meterDataDir(config)
  const cache = new Map()
  const inflight = new Map()
  const newApiStatusCache = new Map()
  const gatewayProbed = new Map()
  const headlessRefreshInflight = new Map()
  const edgeSyncInflight = new Map()
  const autoRecoverFailedAt = new Map()
  const runtimeConsoleCookies = new Map()

  const GATEWAY_POS_TTL_MS = 30 * 60_000
  const GATEWAY_NEG_TTL_MS = 5 * 60_000

  function cachedGatewayProbe(baseURL) {
    const entry = gatewayProbed.get(baseURL)
    if (entry === undefined) return undefined
    const ttl = entry.family === null ? GATEWAY_NEG_TTL_MS : GATEWAY_POS_TTL_MS
    if (Date.now() - entry.at >= ttl) {
      gatewayProbed.delete(baseURL)
      return undefined
    }
    return entry.family
  }

  async function saveConsoleCookie(family, cookie, cookiesList = null) {
    await storeConsoleCookie(ctx.get('credentials'), family, cookie)
    runtimeConsoleCookies.set(family, cookie)
    const dir = profileDirFor(family, dataDir)
    persistJarCookies(dir, cookiesList ?? headerCookiesFor(family, cookie))
    markProfileBound(dir)
    autoRecoverFailedAt.delete(family)
    cache.clear()
  }

  // ── parked console browsers ─────────────────────────────────────────
  //
  // A captured console cookie dies within minutes (StepFun answers "token is
  // expired"). Parking a headless browser on the console page lets that page's
  // own front end keep the session fresh; we only re-read the jar.

  async function stopKeepAlive(family) {
    const entry = KEEPALIVE.get(family)
    if (entry === undefined) return
    KEEPALIVE.delete(family)
    entry.stopped = true
    if (entry.timer !== null) clearInterval(entry.timer)
    try { entry.page?.stop?.() } catch { /* already gone */ }
  }

  async function stopAllKeepAlive() {
    for (const family of [...KEEPALIVE.keys()]) await stopKeepAlive(family)
  }

  /** Re-read the parked browser's jar and refresh the stored cookie when it moved. */
  async function keepAliveTick(family, entry, { force = false, countFailure = true } = {}) {
    if (entry.stopped) return false
    try {
      const result = await entry.page.cdp.send('Storage.getCookies', {}, entry.page.sessionId)
      const cookies = pickConsoleCookies(result.cookies ?? [], LOGIN_TARGETS[family].domains)
      const header = cookieHeaderOf(cookies)
      if (header.length === 0) return false
      if (!force && header === entry.lastHeader) return entry.ok
      entry.lastHeader = header
      try {
        await queryUncached(family, header)
        await saveConsoleCookie(family, header, cookies)
        entry.ok = true
        entry.lastError = null
        entry.failures = 0
        return true
      } catch (error) {
        entry.ok = false
        entry.lastError = String(error?.message ?? error)
        if (countFailure && Date.now() - (entry.startedAt ?? 0) > 15_000) {
          entry.failures = (entry.failures ?? 0) + 1
          // A parked browser that stays signed out is just a wasted process.
          if (entry.failures >= 3) stopKeepAlive(family).catch(() => {})
        }
        return false
      }
    } catch (error) {
      entry.lastError = String(error?.message ?? error)
      return false
    }
  }

  async function startKeepAlive(family, { extraSeedCookies = [], allowUnbound = false } = {}) {
    if (KEEPALIVE.has(family)) return
    const target = LOGIN_TARGETS[family]
    if (target === undefined) return
    const profileDir = profileDirFor(family, dataDir)
    if (!allowUnbound && !profileLooksBound(profileDir)) return
    const baseCookies = resurrectCookiesFor(family, profileDir, await secretFor(family, {}))
    const seedCookies = extraSeedCookies.length > 0
      ? mergeCookieLists(baseCookies, extraSeedCookies)
      : baseCookies
    let page = null
    try {
      page = await openBrowserPage({ headless: true, profileDir, url: target.loginUrl, seedCookies })
    } catch {
      return
    }
    const entry = {
      family,
      page,
      timer: null,
      lastHeader: '',
      lastError: null,
      ok: false,
      stopped: false,
      failures: 0,
      startedAt: Date.now(),
    }
    KEEPALIVE.set(family, entry)
    await keepAliveTick(family, entry, { force: true, countFailure: false })
    // The parked page may still be mid-SSO; check once more shortly after
    // startup instead of waiting a whole interval.
    const warmup = setTimeout(() => {
      keepAliveTick(family, entry, { force: true, countFailure: false }).catch(() => {})
    }, KEEPALIVE_FIRST_TICK_MS)
    warmup.unref?.()
    entry.timer = setInterval(() => { keepAliveTick(family, entry).catch(() => {}) }, KEEPALIVE_MS)
    entry.timer.unref?.()
  }

  async function refreshViaHeadless(family, extraSeedCookies = []) {
    const running = headlessRefreshInflight.get(family)
    if (running !== undefined) return running
    const promise = (async () => {
      const profileDir = profileDirFor(family, dataDir)
      if (extraSeedCookies.length > 0) await stopKeepAlive(family)
      if (!KEEPALIVE.has(family)) {
        await startKeepAlive(family, { extraSeedCookies, allowUnbound: extraSeedCookies.length > 0 })
      }
      const entry = KEEPALIVE.get(family)
      if (entry === undefined) return false
      if (entry.ok === true) return true
      const maxWait = Number.isFinite(Number(config.headlessRefreshMs))
        ? Math.max(200, Number(config.headlessRefreshMs))
        : 15_000
      const deadline = Date.now() + maxWait
      while (Date.now() < deadline && !entry.stopped) {
        const waitMs = Math.min(1_500, Math.max(50, deadline - Date.now()))
        await new Promise((resolve) => setTimeout(resolve, waitMs))
        const ok = await keepAliveTick(family, entry, { force: true, countFailure: false })
        if (ok) return true
      }
      if (!profileLooksBound(profileDir)) stopKeepAlive(family).catch(() => {})
      return entry.ok === true
    })().finally(() => {
      headlessRefreshInflight.delete(family)
    })
    headlessRefreshInflight.set(family, promise)
    return promise
  }

  async function syncConsoleFromEdge(family, { interactive = false } = {}) {
    const target = LOGIN_TARGETS[family]
    if (target === undefined) return { status: 'error', message: `unknown console family "${family}"` }
    const running = edgeSyncInflight.get(family)
    if (running !== undefined) return running
    const promise = (async () => {
      const live = await readLiveBrowserCookies(target.domains, {
        timeoutMs: interactive ? 25_000 : 4_500,
        config,
      })
      if (live.status === 'no-port-file') {
        return {
          status: 'no-port-file',
          message: '未检测到开启远程调试的 Edge 实例。请先在 Edge 地址栏打开 edge://inspect/#remote-debugging 并开启远程调试（首次弹窗点击允许即可）。',
        }
      }
      if (live.status === 'connect-failed') {
        return {
          status: 'connect-failed',
          message: `检测到 Edge 调试端口但无法连接（${live.error ?? 'connection refused'}）。请在 Edge 弹窗中点击“允许”，或打开 edge://inspect/#remote-debugging 确认已开启。`,
        }
      }
      if (live.cookies.length === 0) {
        return {
          status: 'no-cookies',
          browser: live.browser,
          message: `在 ${live.browser} 中未找到 ${target.label} 的登录 Cookie，请先在 Edge 中打开控制台并登录。`,
        }
      }
      const header = cookieHeaderOf(live.cookies)
      const directUsable = family !== 'mimo' || mimoCookieUsable(header)
      if (directUsable) {
        try {
          await queryUncached(family, header)
          await saveConsoleCookie(family, header, live.cookies)
          if (config.disableAutoKeepAlive !== true) startKeepAlive(family).catch(() => {})
          return { status: 'ok', browser: live.browser, via: 'direct', cookieCount: live.cookies.length }
        } catch {
          // Fall through to headless SSO token refresh with Edge's cookies.
        }
      }
      if (config.disableAutoKeepAlive !== true) {
        const refreshed = await refreshViaHeadless(family, live.cookies)
        if (refreshed) {
          cache.clear()
          return { status: 'ok', browser: live.browser, via: 'headless-sso', cookieCount: live.cookies.length }
        }
      }
      return {
        status: 'error',
        browser: live.browser,
        message: `已从 ${live.browser} 读到 ${live.cookies.length} 条 Cookie，但控制台校验失败（登录可能已过期，请在 Edge 中刷新或重新登录控制台后再试）。`,
      }
    })().finally(() => {
      edgeSyncInflight.delete(family)
    })
    edgeSyncInflight.set(family, promise)
    return promise
  }

  async function recoverConsoleSession(family) {
    const lastFail = autoRecoverFailedAt.get(family) ?? 0
    if (Date.now() - lastFail < 30_000) return false
    const edgeRes = await syncConsoleFromEdge(family, { interactive: false }).catch(() => null)
    if (edgeRes?.status === 'ok') return true
    if (profileLooksBound(profileDirFor(family, dataDir)) && config.disableAutoKeepAlive !== true) {
      const refreshed = await refreshViaHeadless(family).catch(() => false)
      if (refreshed) return true
    }
    autoRecoverFailedAt.set(family, Date.now())
    return false
  }

  /** Match config.sub2apiProviders / config.newApiProviders allowlists. */
  function declaredInConfig(provider, row, rawList) {
    const raw = rawList ?? []
    const list = (Array.isArray(raw) ? raw : String(raw).split(/[,\s]+/))
      .map((item) => String(item).trim().toLowerCase())
      .filter((item) => item.length > 0)
    const ns = String(provider ?? '').toLowerCase()
    const url = String(row?.baseURL ?? '').toLowerCase()
    return list.some((item) => ns === item || (url.length > 0 && url.includes(item)))
  }

  function gatewayAssignment(provider, row) {
    const persisted = loadGatewayMap(dataDir)
    const ns = String(provider ?? '').trim()
    if (ns.length > 0) {
      if (persisted[ns] !== undefined) {
        const value = persisted[ns]
        return { value, source: value === 'none' ? 'suppressed' : 'manual' }
      }
      const lower = ns.toLowerCase()
      for (const [key, value] of Object.entries(persisted)) {
        if (key.toLowerCase() === lower) {
          return { value, source: value === 'none' ? 'suppressed' : 'manual' }
        }
      }
    }
    if (declaredInConfig(provider, row, config.newApiProviders)) return { value: 'new-api', source: 'manual' }
    if (declaredInConfig(provider, row, config.sub2apiProviders)) return { value: 'sub2api', source: 'manual' }
    return null
  }

  function familyContext(provider) {
    const rows = readProviderRows(ctx)
    const row = rows[provider] ?? {}
    const assigned = gatewayAssignment(provider, row)
    if (assigned !== null && assigned.value !== 'none') {
      return { family: assigned.value, row, source: 'manual' }
    }
    const suppressed = assigned?.value === 'none'
    let detected = detectFamily(provider, row.baseURL)
    if (suppressed && (detected === 'sub2api' || detected === 'new-api')) {
      detected = null
    }
    if (detected !== null) {
      return { family: detected, row, source: 'url' }
    }
    if (!suppressed) {
      const probed = cachedGatewayProbe(String(row.baseURL ?? '').trim())
      if (typeof probed === 'string') return { family: probed, row, source: 'auto' }
    }
    return null
  }

  async function providerOwnSecret(provider, row) {
    const candidates = []
    if (typeof row?.apiKeyEnv === 'string' && row.apiKeyEnv.trim().length > 0) {
      candidates.push(row.apiKeyEnv.trim())
    }
    const conv = conventionalEnvName(provider)
    if (conv.length > 0 && !candidates.includes(conv)) candidates.push(conv)
    const direct = await resolveCredential(ctx, candidates)
    if (direct !== null) return direct
    if (typeof row?.apiKey === 'string') {
      const rawKey = row.apiKey.trim()
      if (rawKey.length > 0) {
        const resolved = await resolveCredential(ctx, [rawKey])
        if (resolved !== null) return resolved
        if (rawKey.startsWith('sk-')) return rawKey
      }
    }
    return null
  }

  /**
   * Self-hosted Sub2API / New API deployments rarely carry their product name in
   * the URL. Probe lightweight status/usage endpoints once with the provider's
   * own key to classify the gateway automatically.
   */
  async function probeGatewayProvider(provider, { force = false } = {}) {
    const row = readProviderRows(ctx)[provider] ?? {}
    const baseURL = String(row.baseURL ?? '').trim()
    const root = gatewayRootUrl(baseURL)
    if (root === null || isOfficialFirstPartyUrl(baseURL)) return null
    if (!force) {
      const cached = cachedGatewayProbe(baseURL)
      if (cached === null) return null
      if (typeof cached === 'string') return { family: cached, row }
    }

    const secret = await providerOwnSecret(provider, row)
    const headers = secret !== null
      ? { authorization: `Bearer ${secret}`, accept: 'application/json', 'user-agent': BROWSER_UA }
      : null
    const subUrl = sub2apiUsageUrl(baseURL)

    const [statusRes, subRes] = await Promise.all([
      fetchJson(`${root}/api/status`, {
        headers: { accept: 'application/json', 'user-agent': BROWSER_UA },
        timeoutMs: 5_000,
        attempts: 1,
      }).catch(() => ({ status: 0, ok: false, data: null })),
      headers !== null && subUrl !== null
        ? fetchJson(subUrl, { headers, timeoutMs: 5_000, attempts: 1 }).catch(() => ({ status: 0, ok: false, data: null }))
        : Promise.resolve({ status: 0, ok: false, data: null }),
    ])

    const statusData = statusRes?.ok === true ? statusRes.data?.data : null
    if (
      statusRes?.ok === true
      && statusRes.data?.success === true
      && statusData !== null
      && typeof statusData === 'object'
      && (typeof statusData.quota_per_unit === 'number' || typeof statusData.display_in_currency === 'boolean')
    ) {
      const rate = Number(statusData.quota_per_unit)
      if (Number.isFinite(rate) && rate > 0) newApiStatusCache.set(root, { quotaPerUnit: rate, at: Date.now() })
      gatewayProbed.set(baseURL, { family: 'new-api', at: Date.now() })
      return { family: 'new-api', row }
    }

    const subData = subRes?.ok === true ? subRes.data : null
    if (
      subData !== null
      && typeof subData === 'object'
      && !Array.isArray(subData)
      && (
        subData.subscription !== undefined
        || subData.quota !== undefined
        || subData.rate_limits !== undefined
        || subData.balance !== undefined
        || subData.wallet !== undefined
        || subData.daily_usage !== undefined
        || subData.planName !== undefined
      )
      && sub2apiWindows(subData) !== null
    ) {
      gatewayProbed.set(baseURL, { family: 'sub2api', at: Date.now() })
      return { family: 'sub2api', row }
    }

    let tokenRes = { status: 0, ok: false, data: null }
    let billingRes = { status: 0, ok: false, data: null }
    if (headers !== null) {
      ;[tokenRes, billingRes] = await Promise.all([
        fetchJson(`${root}/api/usage/token/`, { headers, timeoutMs: 5_000, attempts: 1 }).catch(() => ({ status: 0, ok: false, data: null })),
        fetchJson(`${root}/v1/dashboard/billing/subscription`, { headers, timeoutMs: 5_000, attempts: 1 }).catch(() => ({ status: 0, ok: false, data: null })),
      ])
      if (
        (tokenRes.ok === true && tokenRes.data?.data?.object === 'token_usage')
        || (billingRes.ok === true && billingRes.data?.object === 'billing_subscription' && Number.isFinite(Number(billingRes.data?.hard_limit_usd)))
      ) {
        gatewayProbed.set(baseURL, { family: 'new-api', at: Date.now() })
        return { family: 'new-api', row }
      }
    }

    const anyHttpReply = [statusRes, subRes, tokenRes, billingRes].some((res) => (res?.status ?? 0) > 0)
    if (anyHttpReply && secret !== null) {
      gatewayProbed.set(baseURL, { family: null, at: Date.now() })
    }
    return null
  }

  async function buildProviderInventory({ probe = false, force = false } = {}) {
    const rows = readProviderRows(ctx)
    const entries = Object.entries(rows)
    if (probe) {
      await Promise.all(entries.map(async ([id, rawRow]) => {
        const row = rawRow !== null && typeof rawRow === 'object' ? rawRow : {}
        const baseURL = String(row.baseURL ?? '').trim()
        const assigned = gatewayAssignment(id, row)
        if (assigned !== null) return
        if (detectFamily(id, baseURL) !== null) return
        if (gatewayRootUrl(baseURL) === null || isOfficialFirstPartyUrl(baseURL)) return
        await probeGatewayProvider(id, { force }).catch(() => null)
      }))
    }
    return entries.map(([id, rawRow]) => {
      const row = rawRow !== null && typeof rawRow === 'object' ? rawRow : {}
      const baseURL = String(row.baseURL ?? '').trim()
      const assigned = gatewayAssignment(id, row)
      const detected = detectFamily(id, baseURL)
      const builtin = detected !== null
        && detected !== 'sub2api'
        && detected !== 'new-api'
        && (baseURL === '' || isOfficialFirstPartyUrl(baseURL))
        && assigned === null

      let family = null
      let source = null
      if (assigned !== null) {
        if (assigned.value === 'none') {
          if (detected !== null && detected !== 'sub2api' && detected !== 'new-api') {
            family = detected
            source = 'url'
          } else {
            family = null
            source = 'suppressed'
          }
        } else {
          family = assigned.value
          source = 'manual'
        }
      } else if (detected !== null) {
        family = detected
        source = 'url'
      } else {
        const probed = cachedGatewayProbe(baseURL)
        if (typeof probed === 'string') {
          family = probed
          source = 'auto'
        }
      }
      return { id, baseURL, family, source, builtin }
    })
  }

  async function secretFor(family, row, provider = '') {
    // Console families are cookie-only: a provider API key would be rejected by
    // the console endpoint, so never let one stand in for the cookie.
    if (family === 'stepfun' || family === 'mimo') {
      const configured = family === 'stepfun'
        ? String(config.stepfunCookie ?? '').trim()
        : String(config.mimoCookie ?? '').trim()
      if (configured.length > 0) return configured
      const resolved = await resolveCredential(ctx, FAMILY_KEY_ENVS[family] ?? [])
      if (resolved !== null) return resolved
      return runtimeConsoleCookies.get(family) ?? null
    }
    if (family === 'deepseek-official') {
      // The route's credential name is configurable on the llm-deepseek entry.
      const route = readDeepseekRoute(ctx)
      return resolveCredential(ctx, [route.apiKeyEnv, ...(FAMILY_KEY_ENVS[family] ?? [])])
    }
    const own = await providerOwnSecret(provider, row)
    if (own !== null) return own
    return resolveCredential(ctx, FAMILY_KEY_ENVS[family] ?? [])
  }

  async function queryUncached(family, secret, row = {}) {
    if (family === 'minimax') return queryMinimax(secret)
    if (family === 'kimi') return queryKimi(secret)
    if (family === 'opencode-go') return queryOpenCodeGo(secret)
    if (family === 'stepfun') return queryStepfun(secret)
    if (family === 'mimo') return queryMimo(secret)
    if (family === 'sub2api') return querySub2api(secret, row.baseURL)
    if (family === 'new-api') return queryNewApi(secret, row.baseURL, newApiStatusCache)
    if (family === 'deepseek-official') return queryDeepSeekOfficial(secret, readDeepseekRoute(ctx))
    throw httpError(400, `unknown quota family "${family}"`)
  }

  /**
   * The account route is not key-based: it reads the signed-in DeepSeek
   * account's wallet through the harness account service, so the plugin never
   * touches the account grant itself.
   */
  async function queryDeepSeekAccount() {
    const account = ctx.get('deepseekAccount')
    if (account === undefined || account === null || typeof account.getBalance !== 'function') {
      throw httpError(502, 'this DeepSeek Harness build exposes no DeepSeek account service')
    }
    const balance = await account.getBalance(accountClientMetadata(ctx))
    if (balance === null) return null
    if (balance.status !== 'ready') throw httpError(502, 'DeepSeek account balance is unavailable right now')
    const windows = deepseekAccountWindows(balance)
    if (windows.length === 0) throw httpError(502, 'DeepSeek account reports no wallet balance')
    return windows
  }

  async function quotaForDeepSeekAccount(provider) {
    const cacheKey = `deepseek-account:${provider}`
    const hit = cache.get(cacheKey)
    if (hit !== undefined && Date.now() - hit.at < hit.ttl) return { ...hit.value, provider }
    const running = inflight.get(cacheKey)
    if (running !== undefined) return running
    const promise = (async () => {
      try {
        const windows = await queryDeepSeekAccount()
        if (windows === null) {
          const value = {
            status: 'no-credential',
            family: 'deepseek-account',
            providerLabel: FAMILY_LABELS['deepseek-account'],
            setupFamily: null,
            message: 'DeepSeek account is not signed in — sign in from Settings → Account, then refresh',
            windows: [],
          }
          cache.set(cacheKey, { at: Date.now(), ttl: ERROR_TTL_MS, value })
          return { ...value, provider }
        }
        const value = {
          status: 'ok',
          family: 'deepseek-account',
          providerLabel: FAMILY_LABELS['deepseek-account'],
          fetchedAt: Date.now(),
          windows,
        }
        cache.set(cacheKey, { at: Date.now(), ttl: OK_TTL_MS, value })
        return { ...value, provider }
      } catch (error) {
        const value = {
          status: 'error',
          family: 'deepseek-account',
          providerLabel: FAMILY_LABELS['deepseek-account'],
          fetchedAt: Date.now(),
          message: error?.httpStatus !== undefined ? error.message : `quota query failed: ${error?.message ?? String(error)}`,
          windows: [],
        }
        cache.set(cacheKey, { at: Date.now(), ttl: ERROR_TTL_MS, value })
        return { ...value, provider }
      } finally {
        inflight.delete(cacheKey)
      }
    })()
    inflight.set(cacheKey, promise)
    return promise
  }

  async function quotaFor(provider, model, familyOverride) {
    const rows = readProviderRows(ctx)
    const row = provider.length > 0 ? (rows[provider] ?? {}) : {}
    let family = familyOverride !== undefined && FAMILY_LABELS[familyOverride] !== undefined ? familyOverride : null
    if (family === null) {
      const context = familyContext(provider)
      if (context === null) {
        const assigned = gatewayAssignment(provider, row)
        const probe = assigned?.value === 'none' ? null : await probeGatewayProvider(provider)
        if (probe === null) {
          return {
            status: 'unsupported',
            provider,
            message: `provider "${provider}" has no quota adapter (assign it to Sub2API / New API in Settings → 内置插件 → 额度徽章 if applicable)`,
            windows: [],
          }
        }
        family = probe.family
      } else {
        family = context.family
      }
    }
    // Xiaomi MiMo models are often served through an OpenCode Go route; when a
    // MiMo console cookie is bound, report the MiMo plan limits for them instead.
    if (family === 'opencode-go' && /mimo/i.test(String(model ?? ''))) {
      const mimoSecret = await secretFor('mimo', {})
      if (mimoSecret !== null && mimoCookieUsable(mimoSecret)) family = 'mimo'
    }
    if (family === 'deepseek-account') return quotaForDeepSeekAccount(provider)

    const isConsole = family === 'stepfun' || family === 'mimo'
    const providerLabel = (family === 'sub2api' || family === 'new-api') && provider.length > 0 && provider.toLowerCase() !== family
      ? `${FAMILY_LABELS[family]} · ${provider}`
      : FAMILY_LABELS[family]

    let secret = await secretFor(family, row, provider)
    if (isConsole && (secret === null || (family === 'mimo' && !mimoCookieUsable(secret)))) {
      const recovered = await recoverConsoleSession(family)
      if (recovered) secret = await secretFor(family, row, provider)
    }

    if (secret === null) {
      const keyHints = row?.apiKeyEnv
        ? String(row.apiKeyEnv)
        : (FAMILY_KEY_ENVS[family] ?? []).join(' / ')
      return {
        status: 'no-credential',
        expired: false,
        provider,
        family,
        providerLabel,
        setupFamily: isConsole ? family : null,
        message: isConsole
          ? `${FAMILY_LABELS[family]} console cookie not configured — sign in from Settings → 内置插件 → 额度徽章, or click the badge`
          : `no API key found for ${providerLabel} (set ${keyHints})`,
        windows: [],
      }
    }
    if (family === 'mimo' && !mimoCookieUsable(secret)) {
      return {
        status: 'no-credential',
        expired: true,
        provider,
        family,
        providerLabel,
        setupFamily: 'mimo',
        message: 'MiMo cookie must contain serviceToken and userId — sync from Edge or paste the full cookie header again',
        windows: [],
      }
    }
    const cacheKey = `${family}:${row.baseURL ?? provider ?? ''}:${secret.slice(0, 10)}:${secret.length}:${model ?? ''}`
    const hit = cache.get(cacheKey)
    if (hit !== undefined && Date.now() - hit.at < hit.ttl) return { ...hit.value, provider, family, providerLabel }
    const running = inflight.get(cacheKey)
    if (running !== undefined) return running
    const promise = (async () => {
      try {
        const windows = await queryUncached(family, secret, row)
        const value = { status: 'ok', family, providerLabel, fetchedAt: Date.now(), windows }
        cache.set(cacheKey, { at: Date.now(), ttl: OK_TTL_MS, value })
        return { ...value, provider }
      } catch (error) {
        // A console that no longer accepts the saved session is a binding
        // problem, not a query failure: try silent recovery via Edge or parked
        // headless browser before prompting the user.
        if (isConsole && error?.authExpired === true) {
          const recovered = await recoverConsoleSession(family)
          if (recovered) {
            const fresh = await secretFor(family, row, provider)
            if (fresh !== null) {
              try {
                const windows = await queryUncached(family, fresh, row)
                const value = { status: 'ok', family, providerLabel, fetchedAt: Date.now(), windows }
                cache.set(cacheKey, { at: Date.now(), ttl: OK_TTL_MS, value })
                return { ...value, provider }
              } catch { /* fall through to the re-bind prompt */ }
            }
          }
          const value = {
            status: 'no-credential',
            expired: true,
            family,
            providerLabel,
            setupFamily: family,
            fetchedAt: Date.now(),
            message: error.message,
            windows: [],
          }
          cache.set(cacheKey, { at: Date.now(), ttl: ERROR_TTL_MS, value })
          return { ...value, provider }
        }
        const value = {
          status: 'error',
          family,
          providerLabel,
          fetchedAt: Date.now(),
          message: error?.httpStatus !== undefined ? error.message : `quota query failed: ${error?.message ?? String(error)}`,
          windows: [],
        }
        cache.set(cacheKey, { at: Date.now(), ttl: ERROR_TTL_MS, value })
        return { ...value, provider }
      } finally {
        inflight.delete(cacheKey)
      }
    })()
    inflight.set(cacheKey, promise)
    return promise
  }

  // ── browser login capture (session runner) ──────────────────────────

  /**
   * Watch one browser's cookie jar until it passes the console check, then
   * store it. Returns true once bound.
   */
  async function captureOnce(session, target, profileDir, { headless, deadline, seedCookies = [] }) {
    session.phase = headless ? 'checking' : 'waiting'
    session.message = headless ? '检查已保存的登录状态…' : '等待你在浏览器里登录…'
    session.updatedAt = Date.now()
    let page = null
    try {
      page = await openBrowserPage({ headless, profileDir, url: target.loginUrl, seedCookies })
    } catch (error) {
      session.lastError = String(error?.message ?? error)
      return false
    }
    session.browserPath = page.browserPath
    session.stop = page.stop
    let fingerprint = ''
    let lastAttemptAt = 0
    try {
      while (Date.now() < deadline) {
        if (session.cancelled) return false
        await new Promise((resolve) => setTimeout(resolve, LOGIN_POLL_MS))
        let cookies = []
        try {
          const result = await page.cdp.send('Storage.getCookies', {}, page.sessionId)
          cookies = pickConsoleCookies(result.cookies ?? [], target.domains)
        } catch (error) {
          session.lastError = String(error?.message ?? error)
          continue
        }
        session.cookieCount = cookies.length
        session.updatedAt = Date.now()
        const candidate = cookieHeaderOf(cookies)
        if (candidate.length === 0) continue
        // Re-check only when the jar changed, so a signed-out browser does not
        // hammer the console.
        if (candidate === fingerprint && Date.now() - lastAttemptAt < 15_000) continue
        fingerprint = candidate
        lastAttemptAt = Date.now()
        if (!headless) session.message = '正在校验控制台登录状态…'
        try {
          await queryUncached(session.family, candidate)
          await saveConsoleCookie(session.family, candidate, cookies)
          session.phase = 'bound'
          session.message = '已绑定 ✓'
          session.updatedAt = Date.now()
          // Park a headless browser on the console so its own front end keeps
          // refreshing the short-lived token.
          session.parkAfterBind = true
          return true
        } catch (error) {
          session.lastError = error?.httpStatus !== undefined ? error.message : String(error?.message ?? error)
          if (!headless) session.message = '等待你在浏览器里登录…'
        }
      }
      return false
    } finally {
      page.stop()
      session.stop = null
    }
  }

  async function runLoginSession(session) {
    const target = LOGIN_TARGETS[session.family]
    const profileDir = profileDirFor(session.family, dataDir)
    const seedCookies = resurrectCookiesFor(session.family, profileDir, await secretFor(session.family, {}).catch(() => null))
    try {
      // A profile that is still signed in binds silently, with no window.
      if (profileLooksBound(profileDir)) {
        const quick = await captureOnce(session, target, profileDir, { headless: true, deadline: Date.now() + LOGIN_QUICK_MS, seedCookies })
        if (quick) {
          if (session.parkAfterBind === true) startKeepAlive(session.family).catch(() => {})
          return
        }
        if (session.cancelled) { session.phase = 'cancelled'; session.message = '已取消'; return }
      }
      session.phase = 'waiting'
      session.message = `请在打开的浏览器里登录 ${target.label}，登录后会自动绑定`
      session.updatedAt = Date.now()
      const bound = await captureOnce(session, target, profileDir, { headless: false, deadline: Date.now() + LOGIN_TIMEOUT_MS, seedCookies })
      if (bound) {
        if (session.parkAfterBind === true) startKeepAlive(session.family).catch(() => {})
        return
      }
      if (session.cancelled) { session.phase = 'cancelled'; session.message = '已取消' }
      else { session.phase = 'timeout'; session.message = '等待超时，请重试' }
    } catch (error) {
      session.phase = 'error'
      session.message = String(error?.message ?? error)
      session.lastError = session.message
    } finally {
      session.updatedAt = Date.now()
      session.stop?.()
      session.stop = null
    }
  }

  function startLoginSession(family) {
    const existing = LOGIN_SESSIONS.get(family)
    if (existing !== undefined && (existing.phase === 'checking' || existing.phase === 'waiting' || existing.phase === 'starting')) {
      return loginSnapshot(existing)
    }
    const session = {
      family,
      phase: 'starting',
      message: '启动浏览器…',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      lastError: null,
      cookieCount: 0,
      browserPath: null,
      stop: null,
      cancelled: false,
    }
    LOGIN_SESSIONS.set(family, session)
    // The parked browser holds this profile; release it before launching again.
    stopKeepAlive(family).finally(() => {
      runLoginSession(session).catch(() => {})
    })
    return loginSnapshot(session)
  }

  function cancelLoginSession(family) {
    const session = LOGIN_SESSIONS.get(family)
    if (session === undefined) return { phase: 'idle' }
    session.cancelled = true
    session.stop?.()
    session.stop = null
    session.phase = 'cancelled'
    session.message = '已取消'
    session.updatedAt = Date.now()
    return loginSnapshot(session)
  }

  function setupPageHtml(family) {
    const target = CONSOLE_TARGETS[family]
    const placeholder = family === 'stepfun' ? 'Oasis-Webid=…; …' : 'api-platform_serviceToken=…; userId=…; …'
    return `<!doctype html><html><head><meta charset="utf-8"><title>${target.title} · 额度徽章</title><style>
body{font:13px/1.7 system-ui,sans-serif;margin:0;padding:28px;background:#f7f8fa;color:#202124}
main{max-width:460px;margin:0 auto;background:#fff;border:1px solid #e3e5e8;border-radius:10px;padding:22px 26px}
h1{font-size:16px;margin:0 0 10px}p{margin:6px 0;color:#5f6368}code{background:#f1f3f4;padding:1px 5px;border-radius:4px}
textarea{width:100%;box-sizing:border-box;min-height:88px;margin:10px 0;border:1px solid #dadce0;border-radius:6px;padding:8px;font:inherit;font-size:12px}
button{background:#1a73e8;color:#fff;border:none;border-radius:6px;padding:8px 16px;font:inherit;cursor:pointer}
.ok{color:#188038;font-weight:600}.err{color:#d93025}
#status{margin-top:12px;font-size:12px}</style></head><body><main>
<h1>${target.title} · 绑定额度徽章</h1>
<p>1. 打开 <a href="${target.loginUrl}" target="_blank" rel="noopener">${target.loginUrl}</a> 登录</p>
<p>2. F12 → Network → 刷新页面 → 点任意请求 → 复制整段 <code>Cookie</code> 请求头</p>
<p>3. 粘贴到下面并保存</p>
<textarea id="cookie" placeholder="${placeholder}"></textarea>
<button id="save">保存 / Save</button>
<div id="status"></div>
<script>
document.getElementById('save').onclick = async () => {
  const cookie = document.getElementById('cookie').value.trim()
  const el = document.getElementById('status')
  if (cookie.length === 0) { el.innerHTML = '<span class="err">请先粘贴 Cookie</span>'; return }
  el.textContent = '验证中…'
  try {
    const r = await fetch(location.pathname + location.search, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cookie }) })
    const d = await r.json()
    if (d.status === 'ok') { el.innerHTML = '<span class="ok">✓ 已保存，可以关闭本页</span>' }
    else el.innerHTML = '<span class="err">✗ ' + (d.message ?? 'invalid cookie') + '</span>'
  } catch (e) { el.innerHTML = '<span class="err">✗ ' + e.message + '</span>' }
}
</script></main></body></html>`
  }

  ctx.effect(() => () => {
    for (const session of LOGIN_SESSIONS.values()) {
      session.cancelled = true
      session.stop?.()
      session.stop = null
    }
    stopAllKeepAlive().catch(() => {})
  }, 'dsh-meter: browser login sessions')

  if (config.disableAutoKeepAlive !== true) {
    const bootTimer = setTimeout(() => {
      for (const family of Object.keys(LOGIN_TARGETS)) {
        if (profileLooksBound(profileDirFor(family, dataDir))) {
          startKeepAlive(family).catch(() => {})
        }
      }
    }, 3_000)
    bootTimer.unref?.()
    ctx.effect(() => () => clearTimeout(bootTimer), 'dsh-meter: keepalive boot timer')
  }

  ctx.inject(['webServer'], (webCtx) => {
    const json = (res, code, payload) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(payload))
    }
    const sameOrigin = (req) => {
      const site = req.headers['sec-fetch-site']
      return typeof site !== 'string' || site === 'same-origin' || site === 'none'
    }
    const readJsonBody = async (req) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    }

    ctx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/quota`,
      handler: async (req, res) => {
        try {
          if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
          if (!sameOrigin(req)) return json(res, 403, { error: 'cross-site request refused' })
          const url = new URL(req.url ?? '/', 'http://localhost')
          const provider = url.searchParams.get('provider') ?? ''
          const model = url.searchParams.get('model') ?? ''
          const family = url.searchParams.get('family') ?? undefined
          if (provider.length === 0 && family === undefined) return json(res, 400, { error: 'missing provider parameter' })
          return json(res, 200, await quotaFor(provider, model, family))
        } catch (error) {
          return json(res, 500, { status: 'error', message: String(error?.message ?? error), windows: [] })
        }
      },
    }))

    ctx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/setup`,
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        let family = url.searchParams.get('family') ?? ''
        if (CONSOLE_TARGETS[family] === undefined) family = ''
        if (family.length === 0) {
          const provider = url.searchParams.get('provider') ?? ''
          const context = familyContext(provider)
          if (context !== null && CONSOLE_TARGETS[context.family] !== undefined) family = context.family
        }
        if (family.length === 0) return json(res, 400, { error: 'setup supports the stepfun / mimo families only' })
        if (!sameOrigin(req)) return json(res, 403, { error: 'cross-site request refused' })
        if (req.method === 'POST') {
          try {
            const body = await readJsonBody(req)
            const cookie = String(body.cookie ?? '').trim()
            if (cookie.length === 0) return json(res, 400, { status: 'error', message: 'cookie is empty' })
            await queryUncached(family, cookie)
            await saveConsoleCookie(family, cookie)
            return json(res, 200, { status: 'ok' })
          } catch (error) {
            return json(res, 200, {
              status: 'error',
              message: error?.httpStatus !== undefined ? error.message : `cookie validation failed: ${error?.message ?? String(error)}`,
            })
          }
        }
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(setupPageHtml(family))
      },
    }))

    ctx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/raw`,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const family = url.searchParams.get('family') ?? 'opencode-go'
          const provider = url.searchParams.get('provider') ?? ''
          const row = provider.length > 0 ? (readProviderRows(ctx)[provider] ?? {}) : {}
          if (family === 'deepseek-account') {
            const account = ctx.get('deepseekAccount')
            if (account === undefined || typeof account.getBalance !== 'function') {
              return json(res, 200, { status: 'no-account-service', family })
            }
            return json(res, 200, { family, balance: await account.getBalance(accountClientMetadata(ctx)) })
          }
          const secret = await secretFor(family, row, provider)
          if (secret === null) return json(res, 200, { status: 'no-credential', family })
          if (family === 'deepseek-official') {
            const { status, data } = await fetchJson(`${deepseekOfficialOrigin(readDeepseekRoute(ctx))}/user/balance`, {
              headers: { authorization: `Bearer ${secret}`, accept: 'application/json' },
            })
            return json(res, 200, { status, family, data })
          }
          if (family === 'stepfun') {
            const base = 'https://platform.stepfun.com/api/step.openapi.devcenter.Dashboard'
            const oasisWebid = /Oasis-Webid=([^;]+)/i.exec(secret)?.[1] ?? ''
            const headers = {
              accept: '*/*',
              'content-type': 'application/json',
              'oasis-appid': '10300',
              'oasis-platform': 'web',
              'oasis-webid': decodeURIComponent(oasisWebid),
              origin: 'https://platform.stepfun.com',
              referer: 'https://platform.stepfun.com/plan-subscribe',
              'user-agent': BROWSER_UA,
              cookie: secret,
            }
            const [rate, plan] = await Promise.all([
              fetchJson(`${base}/QueryStepPlanRateLimit`, { method: 'POST', headers, body: '{}' }),
              fetchJson(`${base}/GetStepPlanStatus`, { method: 'POST', headers, body: '{}' }).catch(() => null),
            ])
            return json(res, 200, { family, rate, plan })
          }
          if (family === 'mimo') {
            const base = 'https://platform.xiaomimimo.com/api/v1'
            const headers = { accept: 'application/json', 'user-agent': BROWSER_UA, cookie: secret }
            const [usage, detail, balance] = await Promise.all([
              fetchJson(`${base}/tokenPlan/usage`, { headers }),
              fetchJson(`${base}/tokenPlan/detail`, { headers }).catch(() => null),
              fetchJson(`${base}/balance`, { headers }).catch(() => null),
            ])
            return json(res, 200, { family, usage, detail, balance })
          }
          let target = null
          if (family === 'sub2api') {
            const usageUrl = sub2apiUsageUrl(row.baseURL)
            if (usageUrl === null) return json(res, 200, { status: 'no-base-url', family })
            const { status, data } = await fetchJson(usageUrl, {
              headers: { authorization: `Bearer ${secret}`, accept: 'application/json', 'user-agent': BROWSER_UA },
            })
            return json(res, 200, { status, family, data })
          }
          if (family === 'new-api') {
            const root = gatewayRootUrl(row.baseURL)
            if (root === null) return json(res, 200, { status: 'no-base-url', family })
            const headers = { authorization: `Bearer ${secret}`, accept: 'application/json', 'user-agent': BROWSER_UA }
            const { startDate, endDate } = newApiBillingDateRange()
            const [statusRes, tokenRes, subRes, usageRes] = await Promise.all([
              fetchJson(`${root}/api/status`, { headers: { accept: 'application/json', 'user-agent': BROWSER_UA } }).catch(() => null),
              fetchNewApiTokenUsage(root, headers),
              fetchJson(`${root}/v1/dashboard/billing/subscription`, { headers }).catch(() => null),
              fetchJson(`${root}/v1/dashboard/billing/usage?start_date=${startDate}&end_date=${endDate}`, { headers }).catch(() => null),
            ])
            return json(res, 200, { family, root, statusRes, tokenRes, subRes, usageRes })
          }
          if (family === 'opencode-go') target = 'https://opencode.ai/zen/go/v1/usage'
          else if (family === 'kimi') target = 'https://api.kimi.com/coding/v1/usages'
          else if (family === 'minimax') target = 'https://www.minimaxi.com/v1/token_plan/remains'
          if (target === null) return json(res, 200, { status: 'no-raw-for-family', family })
          const headers = family === 'opencode-go'
            ? { authorization: `Bearer ${secret}`, 'user-agent': BROWSER_UA }
            : { authorization: `Bearer ${secret}` }
          const { status, data } = await fetchJson(target, { headers })
          return json(res, 200, { status, family, data })
        } catch (error) {
          return json(res, 500, { status: 'error', message: String(error?.message ?? error) })
        }
      },
    }))

    ctx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/login/start`,
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          if (!sameOrigin(req)) return json(res, 403, { error: 'cross-site request refused' })
          const url = new URL(req.url ?? '/', 'http://localhost')
          const family = url.searchParams.get('family') ?? ''
          if (LOGIN_TARGETS[family] === undefined) return json(res, 400, { error: 'login supports the stepfun / mimo families only' })
          return json(res, 200, startLoginSession(family))
        } catch (error) {
          return json(res, 500, { phase: 'error', message: String(error?.message ?? error) })
        }
      },
    }))

    ctx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/login/sync-edge`,
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          if (!sameOrigin(req)) return json(res, 403, { error: 'cross-site request refused' })
          const url = new URL(req.url ?? '/', 'http://localhost')
          const family = url.searchParams.get('family') ?? ''
          if (LOGIN_TARGETS[family] === undefined) return json(res, 400, { status: 'error', message: 'sync-edge supports the stepfun / mimo families only' })
          return json(res, 200, await syncConsoleFromEdge(family, { interactive: true }))
        } catch (error) {
          return json(res, 500, { status: 'error', message: String(error?.message ?? error) })
        }
      },
    }))

    ctx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/login/status`,
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const family = url.searchParams.get('family') ?? ''
        return json(res, 200, loginSnapshot(LOGIN_SESSIONS.get(family)))
      },
    }))

    ctx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/login/cancel`,
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const family = url.searchParams.get('family') ?? ''
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        return json(res, 200, cancelLoginSession(family))
      },
    }))

    ctx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/providers`,
      handler: async (req, res) => {
        try {
          if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
          if (!sameOrigin(req)) return json(res, 403, { error: 'cross-site request refused' })
          const url = new URL(req.url ?? '/', 'http://localhost')
          const probe = url.searchParams.get('probe') === '1'
          const force = url.searchParams.get('force') === '1'
          return json(res, 200, { status: 'ok', providers: await buildProviderInventory({ probe, force }) })
        } catch (error) {
          return json(res, 500, { status: 'error', message: String(error?.message ?? error), providers: [] })
        }
      },
    }))

    ctx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/gateways`,
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          if (!sameOrigin(req)) return json(res, 403, { error: 'cross-site request refused' })
          let body = null
          try {
            body = await readJsonBody(req)
          } catch {
            return json(res, 400, { status: 'error', message: 'invalid JSON body' })
          }
          const map = loadGatewayMap(dataDir)
          if (body?.action === 'reset-suppressed') {
            for (const [key, value] of Object.entries(map)) {
              if (value === 'none') delete map[key]
            }
            saveGatewayMap(dataDir, map)
            gatewayProbed.clear()
            cache.clear()
            return json(res, 200, { status: 'ok', providers: await buildProviderInventory({ probe: true, force: true }) })
          }
          const providerId = String(body?.provider ?? '').trim()
          if (providerId.length === 0) return json(res, 400, { status: 'error', message: 'missing provider' })
          const lower = providerId.toLowerCase()
          for (const key of Object.keys(map)) {
            if (key.toLowerCase() === lower) delete map[key]
          }
          const targetFamily = body?.family
          if (targetFamily === null || targetFamily === undefined || targetFamily === '') {
            // Removed from explicit overrides.
          } else if (targetFamily === 'sub2api' || targetFamily === 'new-api' || targetFamily === 'none') {
            map[providerId] = targetFamily
          } else {
            return json(res, 400, { status: 'error', message: 'invalid gateway family' })
          }
          saveGatewayMap(dataDir, map)
          cache.clear()
          return json(res, 200, { status: 'ok', providers: await buildProviderInventory({ probe: false }) })
        } catch (error) {
          return json(res, 500, { status: 'error', message: String(error?.message ?? error) })
        }
      },
    }))

    ctx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/keepalive`,
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const family = url.searchParams.get('family') ?? ''
        if (LOGIN_TARGETS[family] === undefined) return json(res, 400, { error: 'unknown family' })
        const action = url.searchParams.get('action') ?? 'start'
        if (action === 'stop') {
          await stopKeepAlive(family)
          return json(res, 200, { family, stopped: true })
        }
        await startKeepAlive(family).catch(() => {})
        const entry = KEEPALIVE.get(family)
        return json(res, 200, entry === undefined
          ? { family, running: false }
          : { family, running: true, ok: entry.ok, lastError: entry.lastError, cookieHeaderLength: entry.lastHeader.length })
      },
    }))

    ctx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/hmr`,
      handler: async (req, res) => {
        const out = {}
        const modules = ctx.get('clientModules')
        if (modules === undefined) {
          out.error = 'clientModules service unavailable'
        } else {
          try { out.clientPath = modules.clientPath('dsh-meter') ?? null } catch (error) { out.pathError = String(error?.message ?? error) }
          if (typeof modules.rebuilt === 'function') {
            try { out.rev = modules.rebuilt('dsh-meter') ?? null } catch (error) { out.error = String(error?.message ?? error) }
          } else {
            out.error = 'clientModules.rebuilt unavailable'
          }
        }
        json(res, 200, out)
      },
    }))

    ctx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/log`,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const kind = (url.searchParams.get('kind') ?? 'client').slice(0, 40)
          const detail = (url.searchParams.get('detail') ?? '').slice(0, 2000)
          CLIENT_LOG.push({ at: new Date().toISOString(), kind, detail })
          if (CLIENT_LOG.length > LOG_LIMIT) CLIENT_LOG.splice(0, CLIENT_LOG.length - LOG_LIMIT)
        } catch { /* logging is best effort */ }
        res.writeHead(204, { 'cache-control': 'no-store' })
        res.end()
      },
    }))

    ctx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/status`,
      handler: async (req, res) => {
        const out = { packageName: 'dsh-meter' }
        const modules = ctx.get('clientModules')
        if (modules !== undefined) {
          try {
            const text = JSON.stringify(modules.graph())
            out.clientInBootGraph = text.includes('dsh-meter')
          } catch (error) {
            out.graphError = String(error?.message ?? error)
          }
          try {
            out.clientPath = modules.clientPath('dsh-meter') ?? null
          } catch (error) {
            out.clientPathError = String(error?.message ?? error)
          }
        }
        const rows = readProviderRows(ctx)
        out.providerFamilies = Object.fromEntries(
          Object.keys(rows).map((ns) => [ns, familyContext(ns)?.family ?? detectFamily(ns, rows[ns]?.baseURL)]),
        )
        out.gatewayMap = loadGatewayMap(dataDir)
        out.officialFamilies = {
          'deepseek-account': detectFamily('deepseek-account'),
          'deepseek-official': detectFamily('deepseek-official'),
        }
        out.deepseekRoute = readDeepseekRoute(ctx)
        const account = ctx.get('deepseekAccount')
        out.deepseekAccount = account === undefined
          ? { present: false }
          : { present: true, getBalance: typeof account.getBalance === 'function' }
        out.clientVersion = dshClientVersion(ctx)
        out.configEditor = configEditorDiagnostics(ctx)
        out.credentials = await credentialDiagnostics(ctx)
        out.clientLog = CLIENT_LOG.slice(-30)
        out.keepAlive = [...KEEPALIVE.entries()].map(([family, entry]) => ({
          family,
          ok: entry.ok,
          lastError: entry.lastError,
          cookieHeaderLength: entry.lastHeader.length,
        }))
        const webApp = ctx.get('webApp')
        if (webApp !== undefined && typeof webApp.getAdvertisedUrl === 'function') {
          try { out.advertisedUrl = webApp.getAdvertisedUrl() } catch (error) { out.advertisedUrlError = String(error?.message ?? error) }
        }
        if (modules !== undefined) {
          try { out.clientPath = modules.clientPath('dsh-meter') ?? null } catch { /* optional */ }
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(out))
      },
    }))
  })
}
