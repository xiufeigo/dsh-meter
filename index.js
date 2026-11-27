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
  return { status: response.status, ok: response.ok, data, setCookies: parseSetCookies(response.headers) }
}

/**
 * `Set-Cookie` lines as plain `{ name, value }` pairs: all a cookie jar needs
 * here. Runtimes without `getSetCookie()` hand back one comma-joined string;
 * a comma only starts a new cookie when a `name=` follows it, which keeps
 * `Expires=Wed, 21 Oct …` in one piece.
 */
function parseSetCookies(headers) {
  if (headers === undefined || headers === null) return []
  const lines = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : String(headers.get?.('set-cookie') ?? '').split(/,(?=\s*[^\s;,=]+=[^;,]*)/)
  const out = []
  for (const line of lines) {
    const match = /^\s*([^\s=;]+)=([^;]*)/.exec(String(line ?? ''))
    if (match !== null && match[1].length > 0) out.push({ name: match[1], value: match[2] })
  }
  return out
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

/** Enough of an account name to recognise it, not enough to be one. */
function maskAccount(value) {
  const s = String(value ?? '')
  if (s.length <= 3) return '*'.repeat(s.length)
  const at = s.indexOf('@')
  if (at > 0) return `${s.slice(0, 1)}***${s.slice(at)}`
  return `${s.slice(0, 3)}****${s.slice(-2)}`
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
  mimo: { loginUrl: 'https://platform.xiaomimimo.com/console/plan-manage', envName: 'MIMO_COOKIE', title: '小米 MiMo' },
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
    // The host whose cookie header the usage API actually receives. Cookies on
    // sibling hosts (an SSO app on account.stepfun.com) are kept for seeding a
    // browser profile, but never sent to this host — a browser would not either.
    apiHost: 'platform.stepfun.com',
    // The usage endpoints live under this path; a cookie scoped narrower than
    // this (say /console) must not reach them, one scoped to it must.
    apiPath: '/api/step.openapi.devcenter.Dashboard/',
    label: 'StepFun',
  },
  mimo: {
    // The console plan page, not the site root: `/` is a public product page
    // that never signs anyone in — no SSO round trip, no login form. The
    // console route requires auth, so it both bootstraps the SSO renewal on
    // the parked browser and lands a signed-out session on the password form.
    loginUrl: 'https://platform.xiaomimimo.com/console/plan-manage',
    domains: ['xiaomimimo.com', 'xiaomi.com', 'mi.com'],
    apiHost: 'platform.xiaomimimo.com',
    apiPath: '/api/v1/',
    label: 'MiMo',
  },
}

/** Credential-store names for the optional username / password sign-in. */
const ACCOUNT_ENVS = {
  stepfun: { username: 'STEPFUN_USERNAME', password: 'STEPFUN_PASSWORD' },
  mimo: { username: 'MIMO_USERNAME', password: 'MIMO_PASSWORD' },
}

// StepFun exposes a password sign-in on its passport service (the same one the
// console's account app calls): register an anonymous device, then trade the
// username + password for a signed-in `Oasis-Token`. Pure HTTP, no browser.
const STEPFUN_ORIGIN = 'https://platform.stepfun.com'
const STEPFUN_PASSPORT = `${STEPFUN_ORIGIN}/passport/proto.api.passport.v1.PassportService`
const STEPFUN_TOKEN_RENEW_SKEW_MS = 2 * 60_000

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
// An unchanged jar proves nothing: the server may have retired the token while
// the parked page sat idle. Re-validate at this interval regardless.
const KEEPALIVE_REVALIDATE_MS = 5 * 60_000
// Within a reload loop, the same unchanged jar goes back to the console at
// most this often.
const KEEPALIVE_RECHECK_MS = 5_000
// Silent recovery (password re-login, parked page reload, headless restart)
// is free; a visible login window is not. It opens only after this many
// silent rounds have failed in a row, and at most this often.
const SILENT_FAILURES_BEFORE_WINDOW = 3
const AUTO_LOGIN_WINDOW_GAP_MS = 30 * 60_000
// Exponential backoff after a recovery round fails, so a signed-out account
// cannot turn every badge poll into a browser launch.
const RECOVER_BACKOFF_MS = [60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 30 * 60_000]

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

// Chromium holds its profile directory until it has fully exited. A browser
// closed a moment ago (the login window that just bound) needs a moment before
// another may open the same profile.
const profileReleasedAt = new Map()
const PROFILE_RELEASE_GRACE_MS = 2_000

function cookieStorageKey(cookie) {
  return `${String(cookie?.domain ?? '').toLowerCase()}${String(cookie?.path ?? '/')}\u0000${String(cookie?.name ?? '')}`
}

async function openBrowserPage({ headless, profileDir, url, seedCookies = [], overwriteCookies = [] }) {
  const browserPath = findBrowser()
  if (browserPath === null) {
    throw httpError(500, 'no Chromium browser found — install Chrome or Edge, or set DSH_QUOTA_BROWSER to its executable')
  }
  const remaining = PROFILE_RELEASE_GRACE_MS - (Date.now() - (profileReleasedAt.get(profileDir) ?? 0))
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining))
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
    profileReleasedAt.set(profileDir, Date.now())
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
    // `--headless=new` advertises "HeadlessChrome" in its UA, which SSO pages
    // treat as a bot. Present the console with the UA the quota calls use.
    try {
      await cdp.send('Network.setUserAgentOverride', { userAgent: BROWSER_UA, acceptLanguage: 'zh-CN,zh;q=0.9' }, sessionId)
    } catch { /* older builds lack the override; the page still loads */ }
    // Resurrect the session cookies Chromium dropped on exit, before the
    // console page's first request goes out. Jar seeds only fill cookies the
    // profile does not already hold: the profile's own copy is the freshest.
    // Xiaomi rotates its passToken on every SSO exchange, and the rotation
    // lands in the browser profile at once but in the jar only after the next
    // successful validation — an older jar must never overwrite the newer
    // cookie the browser itself captured. Explicit overwrite cookies (a sync
    // from the user's real browser) are authoritative by construction.
    const overwrites = slimCookies(overwriteCookies)
    if (overwrites.length > 0) {
      try { await cdp.send('Network.setCookies', { cookies: overwrites }, sessionId) } catch { /* best effort */ }
    }
    const fills = slimCookies(seedCookies)
    if (fills.length > 0) {
      let present = null
      try {
        const existing = await cdp.send('Storage.getCookies', {}, sessionId)
        present = new Set((existing.cookies ?? []).map((cookie) => cookieStorageKey(cookie)))
      } catch { /* profile unreadable: seed everything */ }
      const missing = fills.filter((cookie) => present === null || !present.has(cookieStorageKey(cookie)))
      if (missing.length > 0) {
        try { await cdp.send('Network.setCookies', { cookies: missing }, sessionId) } catch { /* best effort */ }
      }
    }
    await cdp.send('Page.navigate', { url }, sessionId)
    return { cdp, sessionId, stop, browserPath }
  } catch (error) {
    stop()
    throw error
  }
}

/**
 * Runs inside the login page (via Runtime.evaluate) until the sign-in form
 * has been filled and submitted. Returns one of:
 *   'waiting'   — no sign-in form on the page (yet)
 *   'captcha'   — credentials typed in, but a code only the user can read
 *                 is wanted; the form is left for them
 *   'submitted' — the form was sent
 * The heuristics target both consoles' account pages (a "password sign-in"
 * tab, an account field, a password field, a submit button) without depending
 * on any one version's class names.
 */
function loginAutofillScript(username, password) {
  const visible = (el) => !!el && el.offsetWidth > 0 && el.offsetHeight > 0 && !el.disabled
  const pick = (selector) => [...document.querySelectorAll(selector)].find(visible) ?? null
  const setValue = (el, value) => {
    const proto = Object.getPrototypeOf(el)
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (setter !== undefined) setter.call(el, value)
    else el.value = value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  let passwordInput = pick('input[type=password]')
  if (passwordInput === null) {
    const tab = [...document.querySelectorAll('a, button, li, span, div, p')]
      .find((el) => visible(el) && el.children.length === 0 && /密码登录|账号密码|password sign|sign in with password/i.test(el.textContent || ''))
    if (tab !== undefined) { tab.click(); return 'waiting' }
    return 'waiting'
  }
  const userInput = pick('#account, input[name="account"], input[name="username"], input[type="tel"], input[type="text"], input[placeholder*="账号"], input[placeholder*="手机"], input[placeholder*="邮箱"], input[placeholder*="Email" i], input[placeholder*="user" i]')
  if (userInput === null) return 'waiting'
  if (userInput.value !== username) setValue(userInput, username)
  if (passwordInput.value !== password) setValue(passwordInput, password)
  // A consent checkbox ("已阅读并同意…协议") gates the submit button on the
  // Xiaomi account page: it stays disabled until the box is ticked, so the
  // form can never be submitted without this click.
  for (const box of document.querySelectorAll('input[type=checkbox]')) {
    if (!visible(box) || box.checked) continue
    const text = box.closest('label')?.textContent ?? box.parentElement?.textContent ?? ''
    if (/协议|隐私|agree|terms|privacy/i.test(text)) box.click()
  }
  const captcha = pick('#captchaCode, input[name="captcha"], input[placeholder*="验证码"], input[placeholder*="captcha" i], input[autocomplete="one-time-code"]')
  if (captcha !== null) return 'captcha'
  const submit = pick('#login-button, button[type="submit"], button.login-btn, .btn-primary, input[type="submit"]')
  if (submit === null) return 'waiting'
  submit.click()
  return 'submitted'
}

function loginAutofillExpression(username, password) {
  return `(${loginAutofillScript.toString()})(${JSON.stringify(username)}, ${JSON.stringify(password)})`
}

/**
 * RFC 6265 domain-match: a host-only cookie (`platform.xiaomimimo.com`) only
 * goes to that exact host; a domain cookie (`.xiaomimimo.com`) also goes to
 * its subdomains. A cookie on `.xiaomi.com` never reaches `xiaomimimo.com`.
 */
function cookieDomainMatches(cookieDomain, host) {
  const domain = String(cookieDomain ?? '').trim().toLowerCase()
  if (domain.length === 0) return true
  const hostOnly = !domain.startsWith('.')
  const bare = domain.replace(/^\./, '')
  if (host === bare) return true
  return !hostOnly && host.endsWith(`.${bare}`)
}

function cookiePathMatches(cookiePath, requestPath) {
  const cp = String(cookiePath ?? '/')
  const rp = String(requestPath ?? '/')
  if (cp === rp) return true
  if (!rp.startsWith(cp)) return false
  return cp.endsWith('/') || rp.charAt(cp.length) === '/'
}

/**
 * The console cookies a browser would send to `host` for a request under
 * `path`, in the order it would send them (longer paths first). Without a
 * `host`, every cookie on the related domains is kept — that is what seeding a
 * browser profile needs. Distinct (domain, path, name) cookies are never
 * collapsed into one: a `serviceToken` on `.mi.com` and one on
 * `.platform.xiaomimimo.com` are different cookies, and the console API host
 * only ever sees one of them.
 */
function pickConsoleCookies(cookies, domains, { host = '', path = '/' } = {}) {
  const related = (cookie) => {
    const h = String(cookie.domain ?? '').replace(/^\./, '').toLowerCase()
    return domains.some((domain) => h === domain || h.endsWith(`.${domain}`))
  }
  const out = []
  for (const cookie of cookies ?? []) {
    if (cookie === null || typeof cookie !== 'object') continue
    if (typeof cookie.name !== 'string' || cookie.name.length === 0) continue
    if (!related(cookie)) continue
    if (host.length > 0) {
      if (!cookieDomainMatches(cookie.domain, host.toLowerCase())) continue
      if (!cookiePathMatches(cookie.path, path)) continue
    }
    out.push(cookie)
  }
  if (host.length > 0) {
    out.sort((a, b) => {
      const pathDelta = String(b.path ?? '/').length - String(a.path ?? '/').length
      if (pathDelta !== 0) return pathDelta
      const aHostOnly = String(a.domain ?? '').startsWith('.') ? 0 : 1
      const bHostOnly = String(b.domain ?? '').startsWith('.') ? 0 : 1
      if (aHostOnly !== bHostOnly) return bHostOnly - aHostOnly
      return String(a.domain ?? '').length - String(b.domain ?? '').length
    })
  }
  return out
}

function cookieHeaderOf(cookies) {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
}

/** The cookie header the console's usage API for `family` would receive. */
function consoleCookieHeader(family, cookies) {
  const target = LOGIN_TARGETS[family]
  if (target === undefined) return cookieHeaderOf(cookies ?? [])
  return cookieHeaderOf(pickConsoleCookies(cookies, target.domains, { host: target.apiHost, path: target.apiPath ?? '/' }))
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
    autofill: session.autofill === true,
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

/**
 * MiMo's console API is authenticated by its `serviceToken` cookie alone; the
 * `userId` cookie lives on account.xiaomi.com and never reaches the API host,
 * so its absence in a host-filtered header is not a problem.
 */
function mimoCookieUsable(cookie) {
  return /serviceToken=[^;\s]+/i.test(String(cookie ?? ''))
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

// ── stepfun password sign-in ─────────────────────────────────────────
//
// The console's account app signs in through `proto.api.passport.v1.PassportService`
// over Connect-JSON: RegisterDevice (an anonymous device — the console itself
// sends `{}`), then SignInByPassword ({ username, password }). Both answer an
// `accessToken.raw` — the JWT the console stores as its `Oasis-Token` cookie —
// plus its `duration`. The landing page's INGRESSCOOKIE keeps both calls on the
// same backend.

/** `exp` of a JWT in epoch milliseconds, or null when the value is not a JWT. */
function jwtExpiryMs(token) {
  const payload = String(token ?? '').split('.')[1]
  if (payload === undefined) return null
  try {
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    const exp = Number(JSON.parse(json)?.exp)
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : null
  } catch {
    return null
  }
}

function cookieValueOf(header, name) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|;\\s*)${escaped}=([^;]*)`, 'i').exec(String(header ?? ''))?.[1] ?? null
}

/** When the saved StepFun session retires, read from the JWT itself. */
function stepfunTokenExpiryMs(cookieHeader) {
  return jwtExpiryMs(cookieValueOf(cookieHeader, 'Oasis-Token'))
}

/**
 * Request headers the console's own client sends on every passport call
 * (see its interceptor): app id, platform, and the web id once the browser
 * has one. A fresh browser has no web id yet, so that header is simply
 * absent rather than empty.
 *
 * No `Oasis-Token` header is ever sent here on purpose. The server treats
 * that header as the bearer credential and rejects the anonymous device
 * token with "token is illegal" — the console only adds the header once a
 * signed-in token exists in its cookie jar, i.e. never for the sign-in call.
 */
function stepfunPassportHeaders(cookie, { webid = '' } = {}) {
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    origin: STEPFUN_ORIGIN,
    referer: `${STEPFUN_ORIGIN}/`,
    'user-agent': BROWSER_UA,
    'oasis-appid': '10300',
    'oasis-platform': 'web',
  }
  if (webid.length > 0) headers['oasis-webid'] = webid
  if (cookie.length > 0) headers.cookie = cookie
  return headers
}

/** The ingress controller's sticky-session cookie from the landing page. */
async function fetchStepfunIngressCookie() {
  try {
    const response = await fetch(`${STEPFUN_ORIGIN}/`, {
      headers: { accept: 'text/html', 'user-agent': BROWSER_UA },
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    })
    const setCookies = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie') ?? '']
    for (const line of setCookies) {
      const match = /^\s*INGRESSCOOKIE=([^;]+)/i.exec(String(line))
      if (match !== null) return `INGRESSCOOKIE=${match[1]}`
    }
  } catch {
    // The passport service also answers without session affinity.
  }
  return ''
}

function stepfunAccessToken(data) {
  const token = data?.accessToken ?? data?.access_token
  const raw = typeof token?.raw === 'string' && token.raw.length > 0 ? token.raw : null
  const duration = Number(token?.duration)
  return { raw, duration: Number.isFinite(duration) && duration > 0 ? duration : null }
}

function passportErrorMessage(data) {
  const detail = Array.isArray(data?.details)
    ? data.details.find((item) => typeof item?.message === 'string' && item.message.length > 0)
    : null
  return String(data?.message ?? detail?.message ?? data?.error ?? '').trim()
}

/**
 * Sign in to StepFun with a username + password and return the cookie header
 * the usage API accepts, plus when that token retires.
 *
 * This mirrors what the console does in a fresh browser, step by step — the
 * passport service rejects anything else as an "illegal" token (verified
 * against the live service):
 *   1. GET the landing page        → INGRESSCOOKIE (sticky session)
 *   2. RegisterDevice with `{}`    → anonymous access token; no web id is sent
 *      yet, and the server answers with the device's own Oasis-Webid and
 *      Oasis-Token cookies, which are kept like a browser would
 *   3. SignInByPassword            → those cookies as they are, the device id
 *      as web id, and no Oasis-Token header (a header token is validated as
 *      a bearer, and the anonymous one is not a legal bearer)
 *   4. the server's Oasis-Token cookie — "<access>...<refresh>", HttpOnly —
 *      is kept verbatim; the usage API rejects anything else in its place
 */
async function stepfunPasswordLogin(username, password) {
  const jar = new Map()
  const absorb = (pairs) => {
    for (const { name, value } of pairs ?? []) jar.set(name, value)
  }
  const cookieHeader = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
  const landing = await fetchJson(`${STEPFUN_ORIGIN}/`, {
    headers: { accept: 'text/html', 'user-agent': BROWSER_UA },
    attempts: 1,
  }).catch(() => null)
  absorb(landing?.setCookies)

  const registered = await fetchJson(`${STEPFUN_PASSPORT}/RegisterDevice`, {
    method: 'POST',
    headers: stepfunPassportHeaders(cookieHeader()),
    body: '{}',
    attempts: 1,
  })
  absorb(registered.setCookies)
  const anonymous = stepfunAccessToken(registered.data)
  if (!registered.ok || anonymous.raw === null) {
    const reason = passportErrorMessage(registered.data)
    throw httpError(502, `StepFun device registration failed (HTTP ${registered.status || 'network'})${reason ? `: ${reason}` : ''}`)
  }
  // The console adopts the server's device id as its web id after registering.
  const deviceId = registered.data?.device?.deviceID ?? registered.data?.device?.device_id
  const webid = typeof deviceId === 'string' && deviceId.length > 0
    ? deviceId
    : (jar.get('Oasis-Webid') ?? globalThis.crypto.randomUUID())
  if (!jar.has('Oasis-Webid')) jar.set('Oasis-Webid', webid)

  const signed = await fetchJson(`${STEPFUN_PASSPORT}/SignInByPassword`, {
    method: 'POST',
    headers: stepfunPassportHeaders(cookieHeader(), { webid }),
    body: JSON.stringify({ username, password }),
    attempts: 1,
  })
  absorb(signed.setCookies)
  const access = stepfunAccessToken(signed.data)
  if (!signed.ok || access.raw === null) {
    const reason = passportErrorMessage(signed.data)
    const error = httpError(502, `StepFun sign-in rejected (HTTP ${signed.status || 'network'})${reason ? `: ${reason}` : ' — check the username and password'}`)
    error.authRejected = true
    throw error
  }
  // Only a cookie the sign-in response itself set may stand for the signed-in
  // session — the jar still holds the anonymous one from registration. The
  // usage API insists on the "<access>...<refresh>" shape and rejects a bare
  // access JWT as an illegal token, so without either source there is no
  // session to bind.
  const signedCookies = new Map((signed.setCookies ?? []).map(({ name, value }) => [name, value]))
  if (signedCookies.has('Oasis-Token')) {
    jar.set('Oasis-Token', signedCookies.get('Oasis-Token'))
  } else {
    const refresh = stepfunRefreshToken(signed.data)
    if (refresh === null) {
      throw httpError(502, 'StepFun sign-in returned no session cookie — this session cannot be bound')
    }
    jar.set('Oasis-Token', `${access.raw}...${refresh}`)
  }
  if (!jar.has('Oasis-Webid')) jar.set('Oasis-Webid', webid)
  return {
    header: stepfunJarHeader(jar),
    webid,
    expiresAt: jwtExpiryMs(access.raw) ?? (access.duration !== null ? Date.now() + access.duration * 1000 : null),
    duration: access.duration,
  }
}

function stepfunRefreshToken(data) {
  const raw = data?.refreshToken?.raw ?? data?.refresh_token?.raw
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}

/** A cookie jar as a request header, in a stable browser-like order. */
function stepfunJarHeader(jar) {
  const priority = ['INGRESSCOOKIE', 'Oasis-Webid', 'Oasis-Token']
  const ordered = priority.filter((name) => jar.has(name))
    .concat([...jar.keys()].filter((name) => !priority.includes(name)))
  return ordered.map((name) => `${name}=${jar.get(name)}`).join('; ')
}

function cookieHeaderToJar(header) {
  const jar = new Map()
  for (const part of String(header ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const name = part.slice(0, eq).trim()
    if (name.length > 0) jar.set(name, part.slice(eq + 1).trim())
  }
  return jar
}

/**
 * Renew a StepFun session the way the console does: an empty RefreshToken
 * call carrying the server's cookies answers a fresh access token and re-sets
 * the session cookie. No password, no new device. Returns null when the
 * server declines — its refresh token retires after about a month — in which
 * case only a password sign-in can bring the session back.
 */
async function stepfunRefresh(cookieHeader) {
  if (cookieValueOf(cookieHeader, 'Oasis-Token') === null) return null
  const jar = cookieHeaderToJar(cookieHeader)
  const webid = decodeURIComponent(jar.get('Oasis-Webid') ?? '')
  let refreshed = null
  try {
    refreshed = await fetchJson(`${STEPFUN_PASSPORT}/RefreshToken`, {
      method: 'POST',
      headers: stepfunPassportHeaders(stepfunJarHeader(jar), { webid }),
      body: '{}',
      attempts: 1,
    })
  } catch {
    return null
  }
  const access = stepfunAccessToken(refreshed.data)
  if (!refreshed.ok || access.raw === null) return null
  for (const { name, value } of refreshed.setCookies ?? []) jar.set(name, value)
  if (!(refreshed.setCookies ?? []).some(({ name }) => name === 'Oasis-Token')) {
    const refresh = stepfunRefreshToken(refreshed.data)
    if (refresh === null) return null
    jar.set('Oasis-Token', `${access.raw}...${refresh}`)
  }
  return {
    header: stepfunJarHeader(jar),
    expiresAt: jwtExpiryMs(access.raw) ?? (access.duration !== null ? Date.now() + access.duration * 1000 : null),
    duration: access.duration,
  }
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
  // Recovery bookkeeping per console family: `failures` / `lastFailAt` drive
  // the exponential backoff (any successful bind resets them). The window
  // cooldown lives apart from that, because a bind must not re-arm the window.
  // `accountCache` mirrors the credential store's answer so synchronous code
  // can ask "is a password configured?".
  const recoverState = new Map()
  const lastLoginWindowAt = new Map()
  const renewInflight = new Map()
  const recoverInflight = new Map()
  // One parked-browser launch per family at a time, and how often it has been
  // asked to stop (a launch that is still in flight must honour a later stop).
  const keepAliveStarting = new Map()
  const keepAliveStops = new Map()
  const accountCache = new Map()
  const lastLoginError = new Map()
  const lastLoginFailedAt = new Map()
  const lastRefreshFailedAt = new Map()
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
    recoverState.delete(family)
    lastLoginError.delete(family)
    lastLoginFailedAt.delete(family)
    lastRefreshFailedAt.delete(family)
    cache.clear()
  }

  // ── parked console browsers ─────────────────────────────────────────
  //
  // A captured console cookie dies within minutes (StepFun answers "token is
  // expired"). Parking a headless browser on the console page lets that page's
  // own front end keep the session fresh; we only re-read the jar.

  async function stopKeepAlive(family) {
    keepAliveStops.set(family, (keepAliveStops.get(family) ?? 0) + 1)
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
      const header = consoleCookieHeader(family, cookies)
      if (header.length === 0) return false
      const now = Date.now()
      const unchanged = header === entry.lastHeader
      // An unchanged jar is not asked about again for a while: the console
      // has just ruled on it either way, and a page mid-sign-in needs time.
      if (unchanged && !force && now - (entry.lastAttemptAt ?? 0) < KEEPALIVE_REVALIDATE_MS) return entry.ok
      if (unchanged && force && now - (entry.lastAttemptAt ?? 0) < KEEPALIVE_RECHECK_MS) return false
      entry.lastHeader = header
      entry.lastAttemptAt = now
      try {
        await queryUncached(family, header)
        await saveConsoleCookie(family, header, cookies)
        entry.ok = true
        entry.lastValidatedAt = now
        entry.lastError = null
        entry.failures = 0
        return true
      } catch (error) {
        entry.ok = false
        entry.lastError = String(error?.message ?? error)
        // Same jar, rejected: the token died server-side. Re-run the console's
        // own sign-in bootstrap by landing on it again.
        if (unchanged && error?.authExpired === true) reloadParkedPage(family, entry).catch(() => {})
        if (countFailure && now - (entry.startedAt ?? 0) > 15_000) {
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

  /**
   * Land the parked page on the console again (not a plain reload: a failed
   * SSO round trip may have left it on a sign-in page). Rate-limited so a
   * rejected jar cannot turn every poll into a navigation.
   */
  async function reloadParkedPage(family, entry) {
    if (entry.stopped || entry.page === null) return false
    const now = Date.now()
    if (now - (entry.lastReloadAt ?? 0) < 30_000) return false
    entry.lastReloadAt = now
    try {
      await entry.page.cdp.send('Page.navigate', { url: LOGIN_TARGETS[family].loginUrl }, entry.page.sessionId)
      return true
    } catch {
      return false
    }
  }

  /** Re-land the parked page, then poll its jar until the console accepts it. */
  async function reloadAndValidate(family, entry, maxWaitMs) {
    entry.ok = false
    await reloadParkedPage(family, entry)
    const deadline = Date.now() + maxWaitMs
    while (Date.now() < deadline && !entry.stopped) {
      const waitMs = Math.min(1_500, Math.max(50, deadline - Date.now()))
      await new Promise((resolve) => setTimeout(resolve, waitMs))
      const ok = await keepAliveTick(family, entry, { force: true, countFailure: false })
      if (ok) return true
    }
    return false
  }

  function headlessRefreshMaxWait() {
    return Number.isFinite(Number(config.headlessRefreshMs))
      ? Math.max(200, Number(config.headlessRefreshMs))
      : 15_000
  }

  // One launch per family at a time: two callers racing past `KEEPALIVE.has`
  // would open two browsers on one profile and lose track of the first.
  function startKeepAlive(family, options = {}) {
    if (KEEPALIVE.has(family)) return Promise.resolve()
    const running = keepAliveStarting.get(family)
    if (running !== undefined) return running
    const promise = launchKeepAlive(family, options).finally(() => {
      keepAliveStarting.delete(family)
    })
    keepAliveStarting.set(family, promise)
    return promise
  }

  async function launchKeepAlive(family, { extraSeedCookies = [], allowUnbound = false } = {}) {
    const target = LOGIN_TARGETS[family]
    if (target === undefined) return
    // A StepFun session is renewed over HTTP; parking a browser for it would
    // only duplicate that work (and fight it over the same account).
    if (family === 'stepfun' && extraSeedCookies.length === 0 && accountCache.get('stepfun') != null) return
    const profileDir = profileDirFor(family, dataDir)
    if (!allowUnbound && !profileLooksBound(profileDir)) return
    const baseCookies = resurrectCookiesFor(family, profileDir, await secretFor(family, {}))
    const stopsAtLaunch = keepAliveStops.get(family) ?? 0
    let page = null
    try {
      page = await openBrowserPage({ headless: true, profileDir, url: target.loginUrl, seedCookies: baseCookies, overwriteCookies: extraSeedCookies })
    } catch {
      return
    }
    // Asked to stop while launching (a login window wants this profile): do
    // not park a browser nobody is tracking.
    if ((keepAliveStops.get(family) ?? 0) !== stopsAtLaunch || KEEPALIVE.has(family)) {
      page.stop()
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
      lastValidatedAt: 0,
      lastAttemptAt: 0,
      // openBrowserPage just landed on the console; count that as the first
      // "reload" so a validation right after does not navigate a second time.
      lastReloadAt: Date.now(),
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
      // Only a jar the console accepted recently counts as refreshed; a stale
      // `ok` flag must never short-circuit recovery.
      if (entry.ok === true && Date.now() - (entry.lastValidatedAt ?? 0) < KEEPALIVE_REVALIDATE_MS) return true
      const ok = await reloadAndValidate(family, entry, headlessRefreshMaxWait())
      if (!ok && !profileLooksBound(profileDir)) stopKeepAlive(family).catch(() => {})
      return ok
    })().finally(() => {
      headlessRefreshInflight.delete(family)
    })
    headlessRefreshInflight.set(family, promise)
    return promise
  }

  /**
   * Manual only: the user pressed "Read Cookie from Edge". Edge authorises
   * remote debugging per connection, so this is never triggered automatically
   * — recovery goes through password sign-in and the parked browser first.
   */
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
      const header = consoleCookieHeader(family, live.cookies)
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

  // ── account sign-in (username + password) ───────────────────────────

  /**
   * The stored username + password for a console family, or null when the
   * user has not configured one. The credential store is the normal home; the
   * plugin config (`stepfunUsername` / `stepfunPassword`) is an override for
   * people who manage their profile as code.
   */
  async function accountFor(family) {
    const envs = ACCOUNT_ENVS[family]
    if (envs === undefined) return null
    const fromConfig = String(config[`${family}Username`] ?? '').trim()
    const username = fromConfig.length > 0
      ? fromConfig
      : (await resolveCredential(ctx, [envs.username]).catch(() => null)) ?? ''
    const passwordFromConfig = String(config[`${family}Password`] ?? '')
    const password = passwordFromConfig.length > 0
      ? passwordFromConfig
      : (await resolveCredential(ctx, [envs.password]).catch(() => null)) ?? ''
    const account = username.length > 0 && password.length > 0 ? { username, password } : null
    accountCache.set(family, account)
    return account
  }

  /** Cookie objects for a StepFun session header, on the host the API lives on. */
  function stepfunSessionCookies(header) {
    return ['INGRESSCOOKIE', 'Oasis-Webid', 'Oasis-Token'].flatMap((name) => {
      const value = cookieValueOf(header, name)
      return value === null
        ? []
        : [{ name, value, domain: 'platform.stepfun.com', path: '/', secure: true, httpOnly: true }]
    })
  }

  /** Store a StepFun session header, plus the cookies it names, for a profile. */
  async function persistStepfunSession(header) {
    const dir = profileDirFor('stepfun', dataDir)
    const replaced = new Set(['INGRESSCOOKIE', 'Oasis-Webid', 'Oasis-Token'])
    const kept = loadJarCookies(dir).filter((cookie) => !replaced.has(cookie.name))
    await saveConsoleCookie('stepfun', header, mergeCookieLists(kept, stepfunSessionCookies(header)))
  }

  /** The password rung on its own; callers provide the single-flight guard. */
  async function stepfunPasswordSignInUnchecked() {
    const account = await accountFor('stepfun').catch(() => null)
    if (account === null) return false
    if (Date.now() - (lastLoginFailedAt.get('stepfun') ?? 0) < 30_000) return false
    try {
      const result = await stepfunPasswordLogin(account.username, account.password)
      await persistStepfunSession(result.header)
      lastLoginError.delete('stepfun')
      lastLoginFailedAt.delete('stepfun')
      lastRefreshFailedAt.delete('stepfun')
      return true
    } catch (error) {
      lastLoginError.set('stepfun', String(error?.message ?? error))
      lastLoginFailedAt.set('stepfun', Date.now())
      return false
    }
  }

  /**
   * Bring the StepFun session back without bothering anyone, exactly as the
   * console does: first its own RefreshToken exchange on the stored cookies
   * (no password, no new device), and only when the server declines that —
   * its refresh token retires after about a month — the stored username and
   * password. Each rung has a short cooldown after a failure, so a poll every
   * few minutes cannot turn into a storm of registrations or passwords.
   */
  async function stepfunRenew() {
    const running = renewInflight.get('stepfun')
    if (running !== undefined) return running
    const promise = (async () => {
      const current = await secretFor('stepfun', {}, '').catch(() => null)
      if (current !== null && Date.now() - (lastRefreshFailedAt.get('stepfun') ?? 0) >= 60_000) {
        const refreshed = await stepfunRefresh(current).catch(() => null)
        if (refreshed !== null) {
          await persistStepfunSession(refreshed.header)
          lastRefreshFailedAt.delete('stepfun')
          return true
        }
        lastRefreshFailedAt.set('stepfun', Date.now())
      }
      return await stepfunPasswordSignInUnchecked()
    })().finally(() => {
      renewInflight.delete('stepfun')
    })
    renewInflight.set('stepfun', promise)
    return promise
  }

  /** Prove the stored credentials with a password sign-in (single flight). */
  async function stepfunPasswordSignIn() {
    const running = renewInflight.get('stepfun')
    if (running !== undefined) await running.catch(() => false)
    const promise = stepfunPasswordSignInUnchecked().finally(() => {
      renewInflight.delete('stepfun')
    })
    renewInflight.set('stepfun', promise)
    return promise
  }

  // ── recovery ladder ─────────────────────────────────────────────────

  function recoverBackoff(family) {
    let state = recoverState.get(family)
    if (state === undefined) {
      state = { failures: 0, lastFailAt: 0 }
      recoverState.set(family, state)
    }
    return state
  }

  function recoverBackoffSchedule() {
    const custom = config.recoverBackoffMs
    if (Array.isArray(custom)) {
      const list = custom.map(Number).filter((ms) => Number.isFinite(ms) && ms >= 0)
      if (list.length > 0) return list
    }
    return RECOVER_BACKOFF_MS
  }

  /** Silent rounds that must fail in a row before a visible window is opened. */
  function silentFailuresBeforeWindow() {
    const n = Number(config.silentFailuresBeforeWindow)
    return Number.isInteger(n) && n >= 1 ? n : SILENT_FAILURES_BEFORE_WINDOW
  }

  /** Milliseconds until the next recovery round may run (0 = now). */
  function recoverBlockedMs(family) {
    const state = recoverState.get(family)
    if (state === undefined || state.failures === 0) return 0
    const schedule = recoverBackoffSchedule()
    const delay = schedule[Math.min(state.failures, schedule.length) - 1]
    return Math.max(0, state.lastFailAt + delay - Date.now())
  }

  /**
   * A console family's saved session was rejected. Climb the silent rungs
   * first — for StepFun a token refresh or a password sign-in over HTTP, for
   * the others the parked browser re-landing on the console so its own front
   * end re-runs the sign-in round trip. Only when `silentFailuresBeforeWindow`
   * rounds have failed in a row does a visible login window open, at most
   * twice an hour, with a stored username + password typed in ahead of time
   * (MiMo may still ask for an SMS code, which only the user can read). Edge
   * is never touched here; it stays a manual button.
   */
  async function recoverConsoleSession(family, { allowWindow = true } = {}) {
    // One round per family at a time. Several providers share a console
    // family (every Xiaomi route is MiMo); concurrent callers must share one
    // round rather than each count it as a failure of its own.
    const running = recoverInflight.get(family)
    if (running !== undefined) return running
    const promise = recoverConsoleRound(family, { allowWindow }).finally(() => {
      recoverInflight.delete(family)
    })
    recoverInflight.set(family, promise)
    return promise
  }

  async function recoverConsoleRound(family, { allowWindow }) {
    const failureCount = () => recoverState.get(family)?.failures ?? 0
    // A login window is already open for this family: it holds the profile
    // and the badge is watching it, so there is nothing to do until it ends.
    const session = LOGIN_SESSIONS.get(family)
    if (session !== undefined && (session.phase === 'starting' || session.phase === 'checking' || session.phase === 'waiting')) {
      return { recovered: false, via: 'window', window: 'opened', retryAfter: 0, failures: failureCount() }
    }
    const blocked = recoverBlockedMs(family)
    if (blocked > 0) return { recovered: false, retryAfter: blocked, failures: failureCount() }
    const state = recoverBackoff(family)
    const account = await accountFor(family).catch(() => null)
    // For StepFun the stored credentials are the silent path (a token refresh,
    // else a password sign-in): no browser can help, since its profile holds
    // no SSO cookie to re-exchange, so none is launched.
    const credentialsAreTheSilentPath = family === 'stepfun'
    // Rung 1: refresh / password sign-in over HTTP, each with its own cooldown.
    let via = null
    if (credentialsAreTheSilentPath) {
      if (await stepfunRenew().catch(() => false)) via = 'http'
    }
    // Rung 2: the parked browser re-lands on the console.
    if (via === null && config.disableAutoKeepAlive !== true && !credentialsAreTheSilentPath) {
      const entry = KEEPALIVE.get(family)
      const ok = entry !== undefined
        ? await reloadAndValidate(family, entry, headlessRefreshMaxWait()).catch(() => false)
        : profileLooksBound(profileDirFor(family, dataDir))
          ? await refreshViaHeadless(family).catch(() => false)
          : false
      if (ok) via = 'parked'
    }
    if (via !== null) {
      state.failures = 0
      state.lastFailAt = 0
      return { recovered: true, via, retryAfter: 0, failures: 0 }
    }
    // Every silent rung failed: count the round, back off, and only after
    // several in a row ask the user with a visible window. Its cooldown is
    // kept apart from the round counter, which any bind resets.
    state.failures += 1
    state.lastFailAt = Date.now()
    const failures = state.failures
    const lastWindowAt = lastLoginWindowAt.get(family) ?? 0
    if (allowWindow && config.disableAutoLoginWindow !== true
      && failures >= silentFailuresBeforeWindow()
      && Date.now() - lastWindowAt >= AUTO_LOGIN_WINDOW_GAP_MS) {
      lastLoginWindowAt.set(family, Date.now())
      startLoginSession(family, { skipHeadless: true, autofill: account })
      return { recovered: false, via: 'window', window: 'opened', retryAfter: 0, failures }
    }
    return { recovered: false, retryAfter: recoverBlockedMs(family), failures }
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
    // StepFun: the session is a JWT; renew it just before it retires instead
    // of waiting for the console to reject it (a token refresh first, a
    // password sign-in only when that is declined).
    if (family === 'stepfun' && secret !== null) {
      const expiry = stepfunTokenExpiryMs(secret)
      if (expiry !== null && expiry - Date.now() < STEPFUN_TOKEN_RENEW_SKEW_MS) {
        if (await stepfunRenew().catch(() => false)) secret = await secretFor(family, row, provider)
      }
    }
    let recovery = { recovered: false, retryAfter: 0, failures: 0 }
    const wasBound = isConsole && profileLooksBound(profileDirFor(family, dataDir))
    if (isConsole && (secret === null || (family === 'mimo' && !mimoCookieUsable(secret)))) {
      // A profile that was never bound has nothing to recover: the badge asks
      // the user to sign in, and no window opens by itself.
      recovery = await recoverConsoleSession(family, { allowWindow: wasBound })
      if (recovery.recovered) secret = await secretFor(family, row, provider)
    }
    const recoveryFields = {
      ...(recovery.retryAfter > 0 ? { retryAfter: recovery.retryAfter } : {}),
      ...(recovery.window === 'opened' ? { loginWindow: 'opened' } : {}),
    }
    /** What to tell the user about a console session the console rejected. */
    const recoveryMessage = (fallback) => {
      if (recovery.window === 'opened') return `${FAMILY_LABELS[family]} 登录窗口已打开，完成登录后徽章会自动恢复`
      if (!wasBound) return fallback
      const needed = silentFailuresBeforeWindow()
      const head = recovery.failures < needed
        ? `${FAMILY_LABELS[family]} 登录已过期，正在静默续期（第 ${recovery.failures}/${needed} 次，连续 ${needed} 次失败后会打开登录窗口）`
        : `${FAMILY_LABELS[family]} 静默续期已连续失败 ${recovery.failures} 次；登录窗口每 30 分钟最多打开一次，也可以点此手动绑定`
      const loginError = lastLoginError.get(family)
      return loginError === undefined ? head : `${head}：${loginError}`
    }

    if (secret === null) {
      const keyHints = row?.apiKeyEnv
        ? String(row.apiKeyEnv)
        : (FAMILY_KEY_ENVS[family] ?? []).join(' / ')
      return {
        status: 'no-credential',
        expired: wasBound || recovery.window === 'opened' || lastLoginError.has(family),
        provider,
        family,
        providerLabel,
        setupFamily: isConsole ? family : null,
        message: !isConsole
          ? `no API key found for ${providerLabel} (set ${keyHints})`
          : recoveryMessage(`${FAMILY_LABELS[family]} console cookie not configured — sign in from Settings → 内置插件 → 额度徽章, or click the badge`),
        windows: [],
        ...recoveryFields,
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
        message: 'MiMo cookie must contain serviceToken — sign in again from Settings → 内置插件 → 额度徽章',
        windows: [],
        ...recoveryFields,
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
        // problem, not a query failure: climb the silent recovery ladder
        // (password sign-in, parked browser) before prompting the user.
        if (isConsole && error?.authExpired === true) {
          recovery = await recoverConsoleSession(family, { allowWindow: wasBound })
          if (recovery.recovered) {
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
            message: recoveryMessage(error.message),
            windows: [],
            ...(recovery.retryAfter > 0 ? { retryAfter: recovery.retryAfter } : {}),
            ...(recovery.window === 'opened' ? { loginWindow: 'opened' } : {}),
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
   * Keep typing the stored credentials into whatever sign-in form the page
   * shows until it has been submitted once, the session binds, is cancelled,
   * or runs out of time. Runs beside the capture loop; that loop is what
   * decides when we are done.
   */
  async function autofillLogin(session, page, account, deadline) {
    const expression = loginAutofillExpression(account.username, account.password)
    const active = () => !session.cancelled && (session.phase === 'waiting' || session.phase === 'checking')
    session.autofill = true
    session.message = '已打开登录窗口，正在自动填写账号密码…'
    session.updatedAt = Date.now()
    while (Date.now() < deadline && active()) {
      let value = null
      try {
        const result = await page.cdp.send('Runtime.evaluate', { expression, returnByValue: true }, page.sessionId)
        value = result?.result?.value ?? null
      } catch {
        value = null
      }
      const message = value === 'submitted'
        ? '已自动提交账号密码；如果页面要求验证码，请在窗口里完成后等待自动绑定…'
        : value === 'captcha'
          ? '已自动填写账号密码，请在窗口里输入验证码…'
          : '已打开登录窗口，正在自动填写账号密码…'
      if (session.message !== message) { session.message = message; session.updatedAt = Date.now() }
      // The form has been sent once. From here the page is the user's: a
      // rejected password must not be resubmitted until the account locks.
      if (value === 'submitted') return
      await new Promise((resolve) => setTimeout(resolve, 1_500))
    }
  }

  /**
   * Watch one browser's cookie jar until it passes the console check, then
   * store it. Returns true once bound; a launch failure leaves the session
   * in its `error` phase with the reason.
   */
  async function captureOnce(session, target, profileDir, { headless, deadline, seedCookies = [], autofill = null }) {
    if (session.cancelled) return false
    session.phase = headless ? 'checking' : 'waiting'
    session.message = headless ? '检查已保存的登录状态…' : '等待你在浏览器里登录…'
    session.updatedAt = Date.now()
    let page = null
    try {
      page = await openBrowserPage({ headless, profileDir, url: target.loginUrl, seedCookies })
    } catch (error) {
      // Say what went wrong now, instead of reporting a timeout later.
      session.lastError = String(error?.message ?? error)
      session.phase = 'error'
      session.message = `无法启动浏览器：${session.lastError}`
      session.updatedAt = Date.now()
      return false
    }
    session.browserPath = page.browserPath
    session.stop = page.stop
    if (!headless && autofill !== null) autofillLogin(session, page, autofill, deadline).catch(() => {})
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
        // Validate the header the usage API host would receive; keep the whole
        // related jar for re-seeding a profile later.
        const candidate = consoleCookieHeader(session.family, cookies)
        if (candidate.length === 0) continue
        // Re-check only when the jar changed, so a signed-out browser does not
        // hammer the console.
        if (candidate === fingerprint && Date.now() - lastAttemptAt < 15_000) continue
        fingerprint = candidate
        lastAttemptAt = Date.now()
        if (!headless && session.autofill !== true) session.message = '正在校验控制台登录状态…'
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
          if (!headless && session.autofill !== true) session.message = '等待你在浏览器里登录…'
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
      // A profile that is still signed in binds silently, with no window. A
      // recovery-triggered session skips this: the silent rungs already ran.
      if (profileLooksBound(profileDir) && session.skipHeadless !== true) {
        const quick = await captureOnce(session, target, profileDir, { headless: true, deadline: Date.now() + LOGIN_QUICK_MS, seedCookies })
        if (quick) {
          if (session.parkAfterBind === true) startKeepAlive(session.family).catch(() => {})
          return
        }
        if (session.cancelled) { session.phase = 'cancelled'; session.message = '已取消'; return }
        // The browser could not be launched at all: keep that reason.
        if (session.phase === 'error') return
      }
      const autofill = session.autofillAccount ?? await accountFor(session.family).catch(() => null)
      session.phase = 'waiting'
      session.message = autofill === null
        ? `请在打开的浏览器里登录 ${target.label}，登录后会自动绑定`
        : `已打开 ${target.label} 登录窗口，账号密码会自动填写，登录后自动绑定`
      session.updatedAt = Date.now()
      const bound = await captureOnce(session, target, profileDir, { headless: false, deadline: Date.now() + LOGIN_TIMEOUT_MS, seedCookies, autofill })
      if (bound) {
        if (session.parkAfterBind === true) startKeepAlive(session.family).catch(() => {})
        return
      }
      if (session.cancelled) { session.phase = 'cancelled'; session.message = '已取消' }
      else if (session.phase === 'error') { /* the launch failure is the message */ }
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

  function startLoginSession(family, { skipHeadless = false, autofill = null } = {}) {
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
      skipHeadless,
      autofillAccount: autofill,
      autofill: false,
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
      (async () => {
        // Know up front whether StepFun signs in over HTTP, so no browser is
        // parked for it.
        await accountFor('stepfun').catch(() => null)
        for (const family of Object.keys(LOGIN_TARGETS)) {
          if (profileLooksBound(profileDirFor(family, dataDir))) {
            startKeepAlive(family).catch(() => {})
          }
        }
      })()
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

    // Username + password for a console family. Stored in the credential
    // store; nothing here ever echoes the password back.
    ctx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/account`,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const family = url.searchParams.get('family') ?? ''
          const envs = ACCOUNT_ENVS[family]
          if (envs === undefined) return json(res, 400, { status: 'error', message: 'account supports the stepfun / mimo families only' })
          if (!sameOrigin(req)) return json(res, 403, { error: 'cross-site request refused' })
          if (req.method === 'GET') {
            const account = await accountFor(family).catch(() => null)
            return json(res, 200, {
              status: 'ok',
              family,
              configured: account !== null,
              usernameMasked: account === null ? null : maskAccount(account.username),
              mode: family === 'stepfun' ? 'http' : 'autofill',
              lastLoginError: lastLoginError.get(family) ?? null,
            })
          }
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          let body = null
          try {
            body = await readJsonBody(req)
          } catch {
            return json(res, 400, { status: 'error', message: 'invalid JSON body' })
          }
          const credentials = ctx.get('credentials')
          if (body?.clear === true) {
            // An empty value resolves to "not configured", so clearing is a
            // write of two empty strings.
            if (credentials !== undefined) {
              await credentials.set(ref(envs.username), '')
              await credentials.set(ref(envs.password), '')
            }
            accountCache.set(family, null)
            lastLoginError.delete(family)
            lastLoginFailedAt.delete(family)
            lastRefreshFailedAt.delete(family)
            return json(res, 200, { status: 'ok', family, configured: false })
          }
          const username = String(body?.username ?? '').trim()
          const password = String(body?.password ?? '')
          if (username.length === 0 || password.length === 0) {
            return json(res, 400, { status: 'error', message: 'username and password are both required' })
          }
          if (credentials !== undefined) {
            await credentials.set(ref(envs.username), username)
            await credentials.set(ref(envs.password), password)
          }
          accountCache.set(family, { username, password })
          lastLoginError.delete(family)
          lastLoginFailedAt.delete(family)
          lastRefreshFailedAt.delete(family)
          recoverState.delete(family)
          cache.clear()
          if (family !== 'stepfun') {
            return json(res, 200, { status: 'ok', family, configured: true, usernameMasked: maskAccount(username), bound: false })
          }
          // A StepFun password signs in over HTTP; a browser parked for it
          // would only fight the password session over the same account.
          await stopKeepAlive('stepfun')
          // Prove the credentials right away and bind the session they buy —
          // and prove the usage API accepts that session, not only the
          // passport service: the two have disagreed before.
          const signedIn = await stepfunPasswordSignIn()
          if (!signedIn) {
            return json(res, 200, {
              status: 'error',
              family,
              configured: true,
              usernameMasked: maskAccount(username),
              message: lastLoginError.get('stepfun') ?? 'StepFun sign-in failed',
            })
          }
          const secret = await secretFor('stepfun', {}, '')
          try {
            await queryUncached('stepfun', secret, {})
          } catch (error) {
            return json(res, 200, {
              status: 'error',
              family,
              configured: true,
              usernameMasked: maskAccount(username),
              message: `signed in, but the console refused the session: ${error?.message ?? String(error)}`,
            })
          }
          return json(res, 200, {
            status: 'ok',
            family,
            configured: true,
            usernameMasked: maskAccount(username),
            bound: true,
            expiresAt: secret === null ? null : stepfunTokenExpiryMs(secret) ?? null,
          })
        } catch (error) {
          return json(res, 500, { status: 'error', message: String(error?.message ?? error) })
        }
      },
    }))

    ctx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/raw`,
      handler: async (req, res) => {
        // Only what the console answered may leave this route: upstream
        // response cookies (session tokens) stay inside the host.
        const publicResult = (result) => (result === null || result === undefined
          ? null
          : { status: result.status, ok: result.ok, data: result.data })
        try {
          if (!sameOrigin(req)) return json(res, 403, { error: 'cross-site request refused' })
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
            return json(res, 200, { family, rate: publicResult(rate), plan: publicResult(plan) })
          }
          if (family === 'mimo') {
            const base = 'https://platform.xiaomimimo.com/api/v1'
            const headers = { accept: 'application/json', 'user-agent': BROWSER_UA, cookie: secret }
            const [usage, detail, balance] = await Promise.all([
              fetchJson(`${base}/tokenPlan/usage`, { headers }),
              fetchJson(`${base}/tokenPlan/detail`, { headers }).catch(() => null),
              fetchJson(`${base}/balance`, { headers }).catch(() => null),
            ])
            return json(res, 200, {
              family,
              usage: publicResult(usage),
              detail: publicResult(detail),
              balance: publicResult(balance),
            })
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
            return json(res, 200, {
              family,
              root,
              statusRes: publicResult(statusRes),
              tokenRes: publicResult(tokenRes),
              subRes: publicResult(subRes),
              usageRes: publicResult(usageRes),
            })
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
          validatedAgoMs: entry.lastValidatedAt === 0 ? null : Date.now() - entry.lastValidatedAt,
          failures: entry.failures ?? 0,
        }))
        out.accounts = {}
        for (const family of Object.keys(ACCOUNT_ENVS)) {
          const account = await accountFor(family).catch(() => null)
          const secret = await secretFor(family, {}, '').catch(() => null)
          out.accounts[family] = {
            configured: account !== null,
            usernameMasked: account === null ? null : maskAccount(account.username),
            lastLoginError: lastLoginError.get(family) ?? null,
            tokenExpiresAt: family === 'stepfun' && secret !== null ? stepfunTokenExpiryMs(secret) ?? null : null,
          }
        }
        out.recovery = Object.fromEntries([...recoverState.entries()].map(([family, state]) => [family, {
          failures: state.failures,
          blockedMs: recoverBlockedMs(family),
          lastWindowAgoMs: (lastLoginWindowAt.get(family) ?? 0) === 0 ? null : Date.now() - lastLoginWindowAt.get(family),
        }]))
        out.silentFailuresBeforeWindow = silentFailuresBeforeWindow()
        out.loginSessions = [...LOGIN_SESSIONS.values()].map(loginSnapshot)
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

/** Pure helpers the smoke tests exercise without a harness. */
export const internals = {
  pickConsoleCookies,
  consoleCookieHeader,
  cookieDomainMatches,
  jwtExpiryMs,
  cookieValueOf,
  stepfunTokenExpiryMs,
  stepfunAccessToken,
  passportErrorMessage,
  parseSetCookies,
  stepfunPasswordLogin,
  maskAccount,
  mimoCookieUsable,
  loginAutofillExpression,
}
