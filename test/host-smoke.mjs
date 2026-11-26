import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { apply, internals } from '../index.js'

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
            const v = credMap.get(k)
            return typeof v === 'string' && v.length > 0 ? { value: v } : null
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
      headers: { get: () => null, getSetCookie: () => result?.setCookies ?? [] },
      async text () { return bodyText },
    }
  }
}

let wsConnections = 0
function makeMockWebSocketClass (cookiesByContext) {
  return class MockWebSocket {
    constructor (url) {
      wsConnections += 1
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

/** A JWT-shaped StepFun access token that retires `secondsFromNow`. */
function fakeJwt (secondsFromNow, sub = 'user-1') {
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, exp: Math.floor(Date.now() / 1000) + secondsFromNow })}.sig`
}

try {
  // ── 0. pure helpers ───────────────────────────────────────────────────
  {
    const cookies = [
      { name: 'serviceToken', value: 'mi-wide', domain: '.mi.com', path: '/' },
      { name: 'userId', value: '1', domain: '.account.xiaomi.com', path: '/' },
      { name: 'serviceToken', value: 'console', domain: 'platform.xiaomimimo.com', path: '/' },
      { name: 'serviceToken', value: 'wide', domain: '.xiaomimimo.com', path: '/' },
      { name: 'pref', value: 'x', domain: 'platform.xiaomimimo.com', path: '/api/' },
      { name: 'consoleOnly', value: 'z', domain: 'platform.xiaomimimo.com', path: '/console' },
      { name: 'unrelated', value: 'y', domain: 'example.com', path: '/' },
    ]
    // Seeding a profile keeps every related cookie, one per (domain, path, name).
    const all = internals.pickConsoleCookies(cookies, ['xiaomimimo.com', 'xiaomi.com', 'mi.com'])
    assert.equal(all.length, 6)
    assert.equal(all.filter((c) => c.name === 'serviceToken').length, 3)
    // The API host only ever sees what a browser would send it for /api/:
    // host-only and domain cookies that match, longer paths first.
    const header = internals.consoleCookieHeader('mimo', cookies)
    assert.equal(header, 'pref=x; serviceToken=console; serviceToken=wide')
    assert.equal(internals.consoleCookieHeader('stepfun', [
      { name: 'Oasis-Token', value: 'sso', domain: 'account.stepfun.com', path: '/' },
      { name: 'Oasis-Token', value: 'api', domain: 'platform.stepfun.com', path: '/' },
      { name: 'Oasis-Webid', value: 'w', domain: '.stepfun.com', path: '/' },
    ]), 'Oasis-Token=api; Oasis-Webid=w')
    assert.equal(internals.cookieDomainMatches('.xiaomi.com', 'platform.xiaomimimo.com'), false)
    assert.equal(internals.cookieDomainMatches('.xiaomimimo.com', 'platform.xiaomimimo.com'), true)
    assert.equal(internals.cookieDomainMatches('platform.xiaomimimo.com', 'platform.xiaomimimo.com'), true)
    assert.equal(internals.cookieDomainMatches('platform.xiaomimimo.com', 'sub.platform.xiaomimimo.com'), false)
    assert.equal(internals.mimoCookieUsable('api-platform_serviceToken=abc'), true)
    assert.equal(internals.mimoCookieUsable('userId=1'), false)

    // JWT expiry drives StepFun's proactive renewal.
    const jwt = fakeJwt(600)
    assert.ok(Math.abs(internals.jwtExpiryMs(jwt) - (Date.now() + 600_000)) < 2_000)
    assert.equal(internals.jwtExpiryMs('not-a-jwt'), null)
    assert.equal(internals.cookieValueOf('a=1; Oasis-Token=ey.abc.sig; b=2', 'Oasis-Token'), 'ey.abc.sig')
    assert.ok(Math.abs(internals.stepfunTokenExpiryMs(`Oasis-Token=${jwt}`) - (Date.now() + 600_000)) < 2_000)
    assert.equal(internals.stepfunAccessToken({ accessToken: { raw: 'r', duration: 90 } }).raw, 'r')
    assert.equal(internals.stepfunAccessToken({ access_token: { raw: 'r' } }).duration, null)
    assert.equal(internals.passportErrorMessage({ code: 'unauthenticated', message: 'wrong password' }), 'wrong password')
    assert.equal(internals.passportErrorMessage({ details: [{ code: 1, message: 'no such user' }] }), 'no such user')
    assert.deepEqual(internals.parseSetCookies({ getSetCookie: () => ['INGRESSCOOKIE=ing-1; Path=/; HttpOnly', 'Oasis-Token=a=b=c; Secure', 'broken'] }), [
      { name: 'INGRESSCOOKIE', value: 'ing-1' },
      { name: 'Oasis-Token', value: 'a=b=c' },
    ])
    assert.deepEqual(internals.parseSetCookies({ get: () => 'Oasis-Webid=w1; Path=/' }), [{ name: 'Oasis-Webid', value: 'w1' }])
    assert.deepEqual(internals.parseSetCookies(undefined), [])
    assert.equal(internals.maskAccount('13812345678'), '138****78')
    assert.equal(internals.maskAccount('someone@example.com'), 's***@example.com')
    const autofill = internals.loginAutofillExpression('u', 'p')
    assert.ok(autofill.includes('"u"') && autofill.includes('"p"') && autofill.startsWith('(') && autofill.endsWith(')'))
  }

  // ── shared mock HTTP upstream ─────────────────────────────────────────
  const fetchCalls = []
  const passportCalls = []
  let plainProxyBillingReady = false
  let stepfunTokenSeconds = 1800
  globalThis.fetch = makeMockFetch(async (url, init) => {
    fetchCalls.push({ url, auth: init?.headers?.authorization ?? '' })
    const cookie = String(init?.headers?.cookie ?? '')

    if (url === 'https://platform.stepfun.com/') {
      return { status: 200, body: '<html>console</html>', setCookies: ['INGRESSCOOKIE=ing-1; Path=/; HttpOnly'] }
    }
    if (url === 'https://platform.stepfun.com/passport/proto.api.passport.v1.PassportService/RegisterDevice') {
      passportCalls.push({ method: 'RegisterDevice', body: init?.body, headers: init?.headers })
      assert.equal(init?.headers?.['oasis-appid'], '10300')
      // A fresh browser has no web id yet: the console sends none here.
      assert.equal(init?.headers?.['oasis-webid'], undefined)
      assert.ok(String(init?.headers?.cookie ?? '').includes('INGRESSCOOKIE=ing-1'))
      return {
        status: 200,
        // The server hands out the device's own cookies; a browser keeps them.
        setCookies: ['Oasis-Webid=dev-server-1; Path=/; Max-Age=25920000; HttpOnly', 'Oasis-Token=srv-anon-blob; Path=/; HttpOnly'],
        data: { accessToken: { raw: 'anon-token', duration: 3600, mode: 'ANONYMOUS' }, refreshToken: { raw: 'rt-anon' }, device: { deviceID: 'dev-server-1' } },
      }
    }
    if (url === 'https://platform.stepfun.com/passport/proto.api.passport.v1.PassportService/SignInByPassword') {
      const body = JSON.parse(String(init?.body ?? '{}'))
      passportCalls.push({ method: 'SignInByPassword', body, cookie, headers: init?.headers })
      // Mirror the console: the server's cookies travel as they are, with
      // the device id as web id — and no Oasis-Token header, which the live
      // service rejects with "token is illegal" for the anonymous token.
      assert.equal(init?.headers?.['oasis-token'], undefined)
      assert.equal(init?.headers?.['oasis-webid'], 'dev-server-1')
      assert.ok(cookie.includes('Oasis-Webid=dev-server-1') && cookie.includes('Oasis-Token=srv-anon-blob') && cookie.includes('INGRESSCOOKIE=ing-1'), cookie)
      if (body.username !== 'user@example.com' || body.password !== 'secret') {
        return { status: 400, data: { code: 'invalid_argument', message: 'password is wrong' } }
      }
      return {
        status: 200,
        setCookies: ['Oasis-Token=srv-seen; Path=/; HttpOnly'],
        data: { accessToken: { raw: fakeJwt(stepfunTokenSeconds), duration: stepfunTokenSeconds, mode: 'SIGN_IN' }, refreshToken: { raw: 'rt' } },
      }
    }
    if (url === 'https://platform.stepfun.com/api/step.openapi.devcenter.Dashboard/QueryStepPlanRateLimit') {
      const token = /Oasis-Token=([^;]+)/.exec(cookie)?.[1] ?? ''
      let retired = false
      try {
        retired = String(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).sub ?? '').startsWith('retired')
      } catch { retired = false }
      if (!retired && (cookie.includes('sessionid=fresh-from-edge') || cookie.includes('Oasis-Token=ey'))) {
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
      // A browser sends platform.xiaomimimo.com only its own serviceToken —
      // neither account.xiaomi.com's userId nor mi.com's serviceToken reach it.
      if (cookie.includes('serviceToken=edge-mimo-token') && !cookie.includes('userId=42') && !cookie.includes('mi-com-token')) {
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

  const testConfig = { dataDir, edgeUserDataDir, disableAutoKeepAlive: true, disableAutoLoginWindow: true }
  apply(h1.ctx, testConfig)

  // ── 1. An expired console cookie is reported, never auto-synced from Edge ──
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
      { name: 'userId', value: '42', domain: '.account.xiaomi.com', path: '/', expires: -1 },
      { name: 'api-platform_serviceToken', value: 'edge-mimo-token', domain: 'platform.xiaomimimo.com', path: '/', expires: -1 },
      // A sibling service token on the wide mi.com domain: must never leak
      // into the header sent to platform.xiaomimimo.com.
      { name: 'serviceToken', value: 'mi-com-token', domain: '.mi.com', path: '/', expires: -1 },
    ],
  })

  // The port file is live now, yet a stale cookie must not open a WebSocket:
  // Edge authorises remote debugging per connection, so it is manual-only.
  const expiredQuota = await h1.invoke('/plugins/dsh-meter/quota', {
    query: '?provider=stepfun&model=step-5',
  })
  assert.equal(expiredQuota.json.status, 'no-credential')
  assert.equal(expiredQuota.json.expired, true)
  assert.equal(wsConnections, 0, 'quota recovery must never connect to Edge on its own')

  // The user presses the button: explicit Edge sync binds.
  const stepfunSync = await h1.invoke('/plugins/dsh-meter/login/sync-edge', {
    method: 'POST',
    query: '?family=stepfun',
  })
  assert.equal(stepfunSync.json.status, 'ok')
  assert.equal(stepfunSync.json.via, 'direct')
  assert.equal(wsConnections, 1)
  const stepfunQuota = await h1.invoke('/plugins/dsh-meter/quota', {
    query: '?provider=stepfun&model=step-5',
  })
  assert.equal(stepfunQuota.json.status, 'ok')
  assert.equal(stepfunQuota.json.windows[0].key, '30d')
  assert.equal(stepfunQuota.json.windows[0].percent, 25)
  assert.ok(h1.credMap.get('STEPFUN_COOKIE').includes('sessionid=fresh-from-edge'))

  // Explicit Edge sync for MiMo keeps account.xiaomi.com SSO cookies in the
  // jar (for re-seeding a profile) while the header only carries the API host's.
  const mimoSync = await h1.invoke('/plugins/dsh-meter/login/sync-edge', {
    method: 'POST',
    query: '?family=mimo',
  })
  assert.equal(mimoSync.json.status, 'ok')
  assert.equal(mimoSync.json.browser, 'Microsoft Edge')
  const mimoJar = JSON.parse(fs.readFileSync(path.join(dataDir, 'browser-profiles', 'mimo', '.dsh-jar.json'), 'utf8'))
  assert.ok(mimoJar.some((c) => c.domain.includes('xiaomi.com') && c.name === 'passToken'))
  assert.equal(h1.credMap.get('MIMO_COOKIE'), 'api-platform_serviceToken=edge-mimo-token')

  // ── 1b. Username + password: StepFun signs in over HTTP, no Edge at all ──
  const accountBefore = await h1.invoke('/plugins/dsh-meter/account', { query: '?family=stepfun' })
  assert.equal(accountBefore.json.configured, false)
  assert.equal(accountBefore.json.mode, 'http')

  const badLogin = await h1.invoke('/plugins/dsh-meter/account', {
    method: 'POST', query: '?family=stepfun', body: { username: 'user@example.com', password: 'wrong' },
  })
  assert.equal(badLogin.json.status, 'error')
  assert.ok(badLogin.json.message.includes('password is wrong'))

  const accountRes = await h1.invoke('/plugins/dsh-meter/account', {
    method: 'POST', query: '?family=stepfun', body: { username: 'user@example.com', password: 'secret' },
  })
  assert.equal(accountRes.json.status, 'ok')
  assert.equal(accountRes.json.bound, true)
  assert.equal(accountRes.json.usernameMasked, 'u***@example.com')
  assert.ok(accountRes.json.expiresAt > Date.now())
  assert.equal(JSON.stringify(accountRes.json).includes('secret'), false, 'the password never echoes back')
  assert.equal(h1.credMap.get('STEPFUN_PASSWORD'), 'secret')
  // The bound header is one browser session: ingress cookie, the server's
  // device id as web id, and the signed-in token overriding the server's.
  const boundHeader = h1.credMap.get('STEPFUN_COOKIE')
  assert.ok(boundHeader.startsWith('INGRESSCOOKIE=ing-1; Oasis-Webid=dev-server-1; Oasis-Token=ey'), boundHeader)
  assert.ok(!boundHeader.includes('srv-seen') && !boundHeader.includes('srv-web'), boundHeader)
  // RegisterDevice was sent with the empty body the console sends, and the
  // sign-in carried the server's own cookies (never the raw anonymous JWT).
  const register = passportCalls.find((c) => c.method === 'RegisterDevice')
  assert.equal(register.body, '{}')
  const signIn = passportCalls.find((c) => c.method === 'SignInByPassword')
  assert.ok(signIn.cookie.includes('Oasis-Token=srv-anon-blob'))
  assert.ok(!signIn.cookie.includes('anon-token'))
  const wsAfterLogin = wsConnections

  // A JWT about to retire is renewed proactively, before any 401.
  h1.credMap.set('STEPFUN_COOKIE', `Oasis-Webid=w; Oasis-Token=${fakeJwt(30)}`)
  stepfunTokenSeconds = 1800
  const renewed = await h1.invoke('/plugins/dsh-meter/quota', { query: '?provider=stepfun&model=step-5' })
  assert.equal(renewed.json.status, 'ok')
  assert.equal(passportCalls.filter((c) => c.method === 'SignInByPassword').length, 3)
  assert.ok(!h1.credMap.get('STEPFUN_COOKIE').includes(fakeJwt(30).split('.')[1]), 'stale JWT replaced')

  // A token the console rejects (still unexpired) is replaced silently on 401.
  h1.credMap.set('STEPFUN_COOKIE', `Oasis-Webid=w; Oasis-Token=${fakeJwt(3600, 'retired')}`)
  const recovered = await h1.invoke('/plugins/dsh-meter/quota', { query: '?provider=stepfun&model=step-5' })
  assert.equal(recovered.json.status, 'ok')
  assert.equal(recovered.json.loginWindow, undefined)
  assert.equal(passportCalls.filter((c) => c.method === 'SignInByPassword').length, 4)
  assert.equal(wsConnections, wsAfterLogin, 'password recovery never touches Edge')

  // Wrong password later: the error is surfaced as the first of several
  // silent rounds, the ladder backs off, and still no Edge and no window.
  h1.credMap.set('STEPFUN_PASSWORD', 'nope')
  h1.credMap.set('STEPFUN_COOKIE', `Oasis-Webid=w; Oasis-Token=${fakeJwt(3600, 'retired-2')}`)
  const failedRecover = await h1.invoke('/plugins/dsh-meter/quota', { query: '?provider=stepfun&model=step-5' })
  assert.equal(failedRecover.json.status, 'no-credential')
  assert.equal(failedRecover.json.expired, true)
  assert.equal(failedRecover.json.loginWindow, undefined)
  assert.ok(failedRecover.json.message.includes('正在静默续期（第 1/3 次'), failedRecover.json.message)
  assert.ok(failedRecover.json.message.includes('password is wrong'))
  assert.ok(failedRecover.json.retryAfter > 0)
  assert.equal(wsConnections, wsAfterLogin)
  // While backing off, a poll does not try the password again.
  const duringBackoff = await h1.invoke('/plugins/dsh-meter/quota', { query: '?provider=stepfun&model=step-5' })
  assert.equal(duringBackoff.json.status, 'no-credential')
  assert.ok(duringBackoff.json.message.includes('第 1/3 次'))
  assert.equal(passportCalls.filter((c) => c.method === 'SignInByPassword').length, 5)
  // Clearing the account reports "not configured" and never returns secrets.
  const cleared = await h1.invoke('/plugins/dsh-meter/account', {
    method: 'POST', query: '?family=stepfun', body: { clear: true },
  })
  assert.equal(cleared.json.configured, false)
  assert.equal((await h1.invoke('/plugins/dsh-meter/account', { query: '?family=stepfun' })).json.configured, false)

  // MiMo without a usable cookie and without a configured account: the badge
  // asks for a sign-in instead of reaching for Edge.
  h1.credMap.set('MIMO_COOKIE', 'userId=42')
  const mimoExpired = await h1.invoke('/plugins/dsh-meter/quota', { query: '?provider=xiaomi-token-plan-cn&model=mimo-v2' })
  assert.equal(mimoExpired.json.status, 'no-credential')
  assert.equal(mimoExpired.json.expired, true)
  assert.equal(mimoExpired.json.setupFamily, 'mimo')
  assert.equal(wsConnections, wsAfterLogin)

  const status = await h1.invoke('/plugins/dsh-meter/status')
  assert.equal(status.json.accounts.stepfun.configured, false)
  assert.equal(status.json.accounts.mimo.configured, false)
  assert.equal(typeof status.json.recovery.stepfun.failures, 'number')
  assert.equal(status.json.silentFailuresBeforeWindow, 3)

  // ── 1c. Three silent rounds must fail in a row before a window opens ──
  // A fresh harness: no backoff (config.recoverBackoffMs), the window allowed,
  // keepalive off, and `node` standing in for the browser so the window
  // "launch" fails fast instead of flashing a real one on the desktop.
  const previousBrowser = process.env.DSH_QUOTA_BROWSER
  process.env.DSH_QUOTA_BROWSER = process.execPath
  const h3dataDir = path.join(tempRoot, 'meter-data-h3')
  const h3 = makeMockHarness({ providersInherited, providersOverride, envCreds: { STEPFUN_COOKIE: 'Oasis-Webid=w; sessionid=expired-1' } })
  apply(h3.ctx, { dataDir: h3dataDir, edgeUserDataDir, disableAutoKeepAlive: true, recoverBackoffMs: [0, 0, 0, 0, 0] })
  // A previously bound profile is what makes a session "recoverable".
  const stepfunProfile = path.join(h3dataDir, 'browser-profiles', 'stepfun')
  fs.mkdirSync(stepfunProfile, { recursive: true })
  fs.writeFileSync(path.join(stepfunProfile, '.dsh-bound'), new Date().toISOString(), 'utf8')
  const rounds = []
  for (const [n, tag] of [[1, 'e1'], [2, 'e22'], [3, 'e333']]) {
    // Different lengths: the quota cache keys on the secret's prefix + length.
    h3.credMap.set('STEPFUN_COOKIE', `Oasis-Webid=w; sessionid=expired-${tag}`)
    const res = await h3.invoke('/plugins/dsh-meter/quota', { query: '?provider=stepfun&model=step-5' })
    const login = await h3.invoke('/plugins/dsh-meter/login/status', { query: '?family=stepfun' })
    rounds.push({ n, status: res.json.status, window: res.json.loginWindow, round: res.json.message?.match(/第 (\d)\/3 次/)?.[1], started: login.json.phase !== 'idle' })
  }
  // Rounds 1 and 2 stay silent; the third opens the window (its "browser" is
  // node, which exits at once, so the session winds down on its own).
  assert.deepEqual(rounds.map((r) => [r.status, r.window ?? null, r.round ?? null, r.started]), [
    ['no-credential', null, '1', false],
    ['no-credential', null, '2', false],
    ['no-credential', 'opened', null, true],
  ])
  assert.equal(wsConnections, wsAfterLogin, 'the ladder never touches Edge')
  const h3status = await h3.invoke('/plugins/dsh-meter/status')
  assert.equal(h3status.json.recovery.stepfun.failures, 3)
  assert.equal(h3status.json.silentFailuresBeforeWindow, 3)
  // Let the third round's session finish (node-as-browser exits at once), so
  // the next round is judged on its own.
  for (let i = 0; i < 40; i += 1) {
    const login = await h3.invoke('/plugins/dsh-meter/login/status', { query: '?family=stepfun' })
    if (!['starting', 'checking', 'waiting'].includes(login.json.phase)) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  // Within the 30-minute window gap no second window opens: the round just counts.
  h3.credMap.set('STEPFUN_COOKIE', 'Oasis-Webid=w; sessionid=expired-e4444')
  const fourth = await h3.invoke('/plugins/dsh-meter/quota', { query: '?provider=stepfun&model=step-5' })
  assert.equal(fourth.json.status, 'no-credential')
  assert.equal(fourth.json.loginWindow, undefined)
  assert.ok(fourth.json.message.includes('已连续失败 4 次'), fourth.json.message)
  process.env.DSH_QUOTA_BROWSER = previousBrowser
  h3.dispose()

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
  apply(h2.ctx, testConfig)
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
