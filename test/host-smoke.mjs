import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { apply } from '../index.js'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-meter-host-test-'))
const dataDir = path.join(tempRoot, 'meter-data')
const edgeUserDataDir = path.join(tempRoot, 'edge-user-data')
fs.mkdirSync(edgeUserDataDir, { recursive: true })

const origFetch = globalThis.fetch
const origWebSocket = globalThis.WebSocket

function makeMockHarness ({ providersInherited, providersOverride, envCreds = {} }) {
  const routes = new Map()
  const disposers = []
  const credMap = new Map(Object.entries(envCreds))

  const ctx = {
    get (name) {
      if (name === 'configEditor') {
        return {
          configuration: () => [{
            entry: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' },
            inherited: { providers: providersInherited },
            override: { providers: providersOverride },
          }],
        }
      }
      if (name === 'credentials') {
        return {
          resolve: async (nameOrRef) => {
            const k = String(nameOrRef)
            return credMap.has(k) ? { value: credMap.get(k) } : null
          },
          set: async (nameOrRef, val) => { credMap.set(String(nameOrRef), String(val)) },
          describe: async (nameOrRef) => ({ key: String(nameOrRef), present: credMap.has(String(nameOrRef)) }),
        }
      }
      return undefined
    },
    effect (fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') disposers.push(cleanup)
      return cleanup
    },
    inject (deps, cb) {
      if (deps.includes('webServer')) {
        cb({
          webServer: {
            register (spec) {
              routes.set(spec.path, spec.handler)
              return () => routes.delete(spec.path)
            },
          },
        })
      }
    },
  }

  async function invoke (routePath, { method = 'GET', query = '', body = undefined } = {}) {
    const handler = routes.get(routePath)
    assert.ok(handler, `expected route ${routePath} to be registered`)
    const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), 'utf8')
    const req = Readable.from(payload.length > 0 ? [payload] : [])
    req.method = method
    req.url = `${routePath}${query}`
    req.headers = { 'sec-fetch-site': 'same-origin' }

    let statusCode = 200
    let headers = {}
    let rawBody = ''
    const res = {
      writeHead (code, hdrs = {}) { statusCode = code; headers = hdrs },
      end (chunk = '') { rawBody += String(chunk) },
    }
    await handler(req, res)
    let json = null
    try { json = rawBody.length > 0 ? JSON.parse(rawBody) : null } catch { json = null }
    return { statusCode, headers, rawBody, json }
  }

  function dispose () {
    for (const d of disposers) {
      try { d() } catch { /* ignore */ }
    }
  }

  return { ctx, routes, credMap, invoke, dispose }
}

function makeMockFetch (handler) {
  return async (url, init = {}) => {
    const result = await handler(String(url), init)
    const status = result?.status ?? 404
    const bodyText = typeof result?.body === 'string'
      ? result.body
      : JSON.stringify(result?.data ?? null)
    return {
      status,
      ok: status >= 200 && status < 300,
      async text () { return bodyText },
    }
  }
}

function makeMockWebSocketClass (cookiesByContext) {
  return class MockWebSocket {
    constructor (url) {
      this.url = url
      this.listeners = new Map()
      queueMicrotask(() => this.#emit('open', {}))
    }

    addEventListener (type, fn) {
      const list = this.listeners.get(type) ?? []
      list.push(fn)
      this.listeners.set(type, list)
    }

    #emit (type, event) {
      for (const fn of this.listeners.get(type) ?? []) fn(event)
    }

    send (raw) {
      const req = JSON.parse(raw)
      queueMicrotask(() => {
        if (req.method === 'Storage.getCookies') {
          const ctxId = req.params?.browserContextId ?? 'default'
          const cookies = cookiesByContext[ctxId] ?? []
          this.#emit('message', { data: JSON.stringify({ id: req.id, result: { cookies } }) })
        } else if (req.method === 'Target.getTargets') {
          const targetInfos = Object.keys(cookiesByContext)
            .filter((k) => k !== 'default')
            .map((browserContextId, i) => ({ targetId: `t${i}`, browserContextId }))
          this.#emit('message', { data: JSON.stringify({ id: req.id, result: { targetInfos } }) })
        } else {
          this.#emit('message', { data: JSON.stringify({ id: req.id, result: {} }) })
        }
      })
    }

    close () {}
  }
}

try {
  // ── shared mock HTTP upstream ───────────────────────────────────────
  const fetchCalls = []
  let plainProxyBillingReady = false
  globalThis.fetch = makeMockFetch(async (url, init) => {
    fetchCalls.push({ url, auth: init?.headers?.authorization ?? '' })
    const cookie = String(init?.headers?.cookie ?? '')

    if (url === 'https://platform.stepfun.com/api/step.openapi.devcenter.Dashboard/QueryStepPlanRateLimit') {
      if (cookie.includes('sessionid=fresh-from-edge')) {
        return {
          status: 200,
          data: {
            plan_credit_rate_limit: {
              subscription_credit_left_rate: 0.75,
              subscription_credit_reset_time: '2027-01-01T00:00:00Z',
            },
          },
        }
      }
      return { status: 401, data: { error: 'token is expired' } }
    }
    if (url === 'https://platform.stepfun.com/api/step.openapi.devcenter.Dashboard/GetStepPlanStatus') {
      return { status: 200, data: {} }
    }
    if (url === 'https://platform.xiaomimimo.com/api/v1/tokenPlan/usage') {
      if (cookie.includes('serviceToken=edge-mimo-token') && cookie.includes('userId=42')) {
        return { status: 200, data: { data: { usage: { percent: 0.2 } } } }
      }
      return { status: 401, data: { message: 'unauthorized' } }
    }
    if (url === 'https://platform.xiaomimimo.com/api/v1/tokenPlan/detail') {
      return { status: 200, data: { data: { planCode: 'monthly', currentPeriodEnd: '2026-12-31 23:59:59' } } }
    }

    // Sub2API custom domain (gw-alpha)
    if (url === 'https://gw-alpha.example.com/v1/usage' && init?.headers?.authorization === 'Bearer sk-d1-from-inherited') {
      const today = new Date().toISOString().slice(0, 10)
      return {
        status: 200,
        data: {
          unit: 'USD',
          subscription: { daily_usage_usd: 1, daily_limit_usd: 10 },
          balance: 8.5,
          daily_usage: [{ date: today, actual_cost: 1.2 }],
        },
      }
    }

    // New API custom domain (gw-beta)
    if (url === 'https://gw-beta.example.com/api/status') {
      return {
        status: 200,
        data: {
          success: true,
          data: { system_name: 'New API', quota_per_unit: 500_000, display_in_currency: true },
        },
      }
    }
    if (url === 'https://gw-beta.example.com/api/usage/token/' && init?.headers?.authorization === 'Bearer sk-relay-literal') {
      return {
        status: 200,
        data: {
          code: true,
          message: 'ok',
          data: {
            object: 'token_usage',
            name: 'Relay Key',
            total_granted: 1_000_000,
            total_used: 250_000,
            total_available: 750_000,
            unlimited_quota: false,
            expires_at: 1_900_000_000,
          },
        },
      }
    }

    // Plain proxy reassigned manually to New API (billing fallback test)
    if (plainProxyBillingReady && url === 'https://plain-proxy.example.com/api/usage/token/' && init?.headers?.authorization === 'Bearer sk-plain-secret') {
      return {
        status: 200,
        data: {
          code: true,
          data: { object: 'token_usage', unlimited_quota: true, total_used: 150_000 },
        },
      }
    }
    if (plainProxyBillingReady && url === 'https://plain-proxy.example.com/v1/dashboard/billing/subscription' && init?.headers?.authorization === 'Bearer sk-plain-secret') {
      return {
        status: 200,
        data: { object: 'billing_subscription', hard_limit_usd: 20, soft_limit_usd: 20 },
      }
    }
    if (plainProxyBillingReady && url.startsWith('https://plain-proxy.example.com/v1/dashboard/billing/usage') && init?.headers?.authorization === 'Bearer sk-plain-secret') {
      return {
        status: 200,
        data: { object: 'list', total_usage: 500 },
      }
    }

    return { status: 404, data: {} }
  })

  const providersInherited = {
    openai: { baseURL: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' },
    minimax: { baseURL: 'https://api.minimaxi.com/v1', apiKeyEnv: 'MINIMAX_API_KEY' },
    d1studio: { baseURL: 'https://old.example.com/v1', apiKeyEnv: 'D1_KEY' },
    myrelay: { baseURL: 'https://gw-beta.example.com/v1', apiKey: 'sk-relay-literal' },
    custom_plain: { baseURL: 'https://plain-proxy.example.com/v1', apiKeyEnv: 'PLAIN_KEY' },
  }
  // Override only replaces baseURL on d1studio to confirm apiKeyEnv is preserved by deep merge.
  const providersOverride = {
    d1studio: { baseURL: 'https://gw-alpha.example.com/v1' },
  }

  const h1 = makeMockHarness({
    providersInherited,
    providersOverride,
    envCreds: {
      D1_KEY: 'sk-d1-from-inherited',
      PLAIN_KEY: 'sk-plain-secret',
      STEPFUN_COOKIE: 'Oasis-Webid=old; sessionid=expired',
    },
  })

  apply(h1.ctx, { dataDir, edgeUserDataDir, disableAutoKeepAlive: true })

  // ── 1. Edge cookie sync (missing port file -> active WebSocket -> quota recovery) ──
  const noPortRes = await h1.invoke('/plugins/dsh-meter/login/sync-edge', {
    method: 'POST',
    query: '?family=stepfun',
  })
  assert.equal(noPortRes.json.status, 'no-port-file')
  assert.ok(noPortRes.json.message.includes('edge://inspect/#remote-debugging'))

  fs.writeFileSync(path.join(edgeUserDataDir, 'DevToolsActivePort'), '9222\n/devtools/browser/edge-test\n', 'utf8')
  globalThis.WebSocket = makeMockWebSocketClass({
    default: [
      { name: 'Oasis-Webid', value: 'w1', domain: '.stepfun.com', path: '/', expires: -1 },
      { name: 'sessionid', value: 'fresh-from-edge', domain: 'platform.stepfun.com', path: '/', expires: -1 },
    ],
    'edge-profile-2': [
      { name: 'passToken', value: 'sso-pass-token', domain: '.account.xiaomi.com', path: '/', expires: -1 },
      { name: 'api-platform_serviceToken', value: 'edge-mimo-token', domain: 'platform.xiaomimimo.com', path: '/', expires: -1 },
      { name: 'userId', value: '42', domain: '.xiaomimimo.com', path: '/', expires: -1 },
    ],
  })

  // StepFun starts with an expired cookie; querying quota auto-syncs from Edge!
  const stepfunQuota = await h1.invoke('/plugins/dsh-meter/quota', {
    query: '?provider=stepfun&model=step-5',
  })
  assert.equal(stepfunQuota.json.status, 'ok')
  assert.equal(stepfunQuota.json.windows[0].key, '30d')
  assert.equal(stepfunQuota.json.windows[0].percent, 25)
  assert.ok(h1.credMap.get('STEPFUN_COOKIE').includes('sessionid=fresh-from-edge'))

  // Explicit Edge sync for MiMo also captures account.xiaomi.com SSO cookie in .dsh-jar.json
  const mimoSync = await h1.invoke('/plugins/dsh-meter/login/sync-edge', {
    method: 'POST',
    query: '?family=mimo',
  })
  assert.equal(mimoSync.json.status, 'ok')
  assert.equal(mimoSync.json.browser, 'Microsoft Edge')
  const mimoJar = JSON.parse(fs.readFileSync(path.join(dataDir, 'browser-profiles', 'mimo', '.dsh-jar.json'), 'utf8'))
  assert.ok(mimoJar.some((c) => c.domain.includes('xiaomi.com') && c.name === 'passToken'))

  // ── 2. URL auto-detection via /providers?probe=1 ────────────────────
  const probeRes = await h1.invoke('/plugins/dsh-meter/providers', { query: '?probe=1' })
  assert.equal(probeRes.json.status, 'ok')
  const byId = Object.fromEntries(probeRes.json.providers.map((p) => [p.id, p]))

  assert.equal(byId.openai.family, null)
  assert.equal(byId.openai.builtin, false)
  assert.equal(fetchCalls.some((c) => c.url.includes('api.openai.com')), false, 'must never probe api.openai.com')

  assert.equal(byId.minimax.family, 'minimax')
  assert.equal(byId.minimax.builtin, true)

  assert.equal(byId.d1studio.family, 'sub2api')
  assert.equal(byId.d1studio.source, 'auto')

  assert.equal(byId.myrelay.family, 'new-api')
  assert.equal(byId.myrelay.source, 'auto')

  assert.equal(byId.custom_plain.family, null)
  assert.equal(byId.custom_plain.source, null)

  // ── 3. Dropdown assignment, persistence, suppression & reset ────────
  plainProxyBillingReady = true
  const assignRes = await h1.invoke('/plugins/dsh-meter/gateways', {
    method: 'POST',
    body: { provider: 'custom_plain', family: 'new-api' },
  })
  assert.equal(assignRes.json.status, 'ok')
  const assignedMap = Object.fromEntries(assignRes.json.providers.map((p) => [p.id, p]))
  assert.equal(assignedMap.custom_plain.family, 'new-api')
  assert.equal(assignedMap.custom_plain.source, 'manual')

  const savedDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'gateways.json'), 'utf8'))
  assert.equal(savedDisk.providers.custom_plain, 'new-api')

  // Suppress auto-detected d1studio
  const suppressRes = await h1.invoke('/plugins/dsh-meter/gateways', {
    method: 'POST',
    body: { provider: 'd1studio', family: 'none' },
  })
  const suppressedMap = Object.fromEntries(suppressRes.json.providers.map((p) => [p.id, p]))
  assert.equal(suppressedMap.d1studio.family, null)
  assert.equal(suppressedMap.d1studio.source, 'suppressed')

  const suppressedQuota = await h1.invoke('/plugins/dsh-meter/quota', { query: '?provider=d1studio' })
  assert.equal(suppressedQuota.json.status, 'unsupported')

  // Reset suppressed and re-probe
  const resetRes = await h1.invoke('/plugins/dsh-meter/gateways', {
    method: 'POST',
    body: { action: 'reset-suppressed' },
  })
  const resetMap = Object.fromEntries(resetRes.json.providers.map((p) => [p.id, p]))
  assert.equal(resetMap.d1studio.family, 'sub2api')
  assert.equal(resetMap.d1studio.source, 'auto')

  // ── 4. Quota responses for New API & Sub2API ────────────────────────
  const myrelayQuota = await h1.invoke('/plugins/dsh-meter/quota', { query: '?provider=myrelay' })
  assert.equal(myrelayQuota.json.status, 'ok')
  assert.equal(myrelayQuota.json.family, 'new-api')
  assert.equal(myrelayQuota.json.providerLabel, 'New API · myrelay')
  assert.equal(myrelayQuota.json.windows[0].key, 'quota')
  assert.equal(myrelayQuota.json.windows[0].percent, 25)
  assert.equal(myrelayQuota.json.windows[1].key, 'balance')
  assert.equal(myrelayQuota.json.windows[1].text, '$1.50')

  // Explicit familyOverride keeps row.baseURL & row.apiKeyEnv for custom_plain
  const plainQuota = await h1.invoke('/plugins/dsh-meter/quota', {
    query: '?provider=custom_plain&family=new-api',
  })
  assert.equal(plainQuota.json.status, 'ok')
  assert.equal(plainQuota.json.providerLabel, 'New API · custom_plain')
  assert.deepEqual(
    plainQuota.json.windows.map((w) => [w.key, w.text]),
    [['balance', '$15.00'], ['used', '$5.00']],
  )

  const sub2apiQuota = await h1.invoke('/plugins/dsh-meter/quota', { query: '?provider=d1studio' })
  assert.equal(sub2apiQuota.json.status, 'ok')
  assert.equal(sub2apiQuota.json.providerLabel, 'Sub2API · d1studio')
  assert.equal(sub2apiQuota.json.windows.find((w) => w.key === 'today')?.text, '$1.20')

  // Reload plugin with same dataDir -> persisted manual gateway assignment survives
  h1.dispose()
  const h2 = makeMockHarness({ providersInherited, providersOverride })
  apply(h2.ctx, { dataDir, edgeUserDataDir, disableAutoKeepAlive: true })
  const reloadedProviders = await h2.invoke('/plugins/dsh-meter/providers')
  const reloadedPlain = reloadedProviders.json.providers.find((p) => p.id === 'custom_plain')
  assert.equal(reloadedPlain.family, 'new-api')
  assert.equal(reloadedPlain.source, 'manual')
  h2.dispose()

  console.log('ALL HOST SMOKE CHECKS PASSED')
} finally {
  globalThis.fetch = origFetch
  globalThis.WebSocket = origWebSocket
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
