/**
 * build: 2026-11-05T22:27:08
 *
 * dsh-meter — Client half.
 *
 * 1. A compact ring in `conversation.composer.dock` — the ambient row under the
 *    composer card, immediately before the composer's own context meter — so it
 *    reads as a sibling of that ring instead of competing with the model
 *    selector. It shows the remaining percentage of this session provider's
 *    tightest usage window; clicking opens a menu-styled panel with every
 *    window (5h / 7d / 30d …).
 * 2. A `settings.plugins.tab` page ("额度徽章") inside Settings → Plugins,
 *    listing every supported provider and letting the two console-cookie
 *    families (StepFun / MiMo) be bound through a one-click browser sign-in.
 *
 * All data comes from the Host half's same-origin routes; this file never
 * touches a credential.
 */
window.__ModuleLoader__.load({
  id: 'dsh-meter',
  factory (require) {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const h = React.createElement

    const NS = 'dsh-meter'
    const REFRESH_MS = 3 * 60 * 1000
    const QUOTA_URL = '/plugins/dsh-meter/quota'
    const SETUP_URL = '/plugins/dsh-meter/setup'
    const LOGIN_URL = '/plugins/dsh-meter/login'
    const LOG_URL = '/plugins/dsh-meter/log'

    // Best-effort client report so the Host can answer "did it run?" over /status.
    function report (kind, detail) {
      try {
        const text = typeof detail === 'string' ? detail : JSON.stringify(detail)
        const url = `${LOG_URL}?kind=${encodeURIComponent(kind)}&detail=${encodeURIComponent(String(text).slice(0, 1800))}`
        fetch(url, { credentials: 'same-origin', keepalive: true }).catch(() => {})
      } catch { /* ignore */ }
    }

    class Boundary extends React.Component {
      constructor (props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError (error) {
        return { error }
      }

      componentDidCatch (error) {
        report(`${this.props.channel}-error`, String(error?.stack ?? error))
      }

      render () {
        return this.state.error === null ? this.props.children : null
      }
    }

    const DICTS = {
      en: {
        settingsNav: 'Quota badge',
        windowsTitle: 'Usage limits',
        remaining: 'left',
        used: 'used',
        resetsIn: 'resets in {duration}',
        resetsAt: 'resets {time}',
        refreshedAt: 'updated {time}',
        refresh: 'Refresh',
        loading: 'Loading…',
        bind: 'Bind',
        bindTitle: 'Bind {provider} console',
        notBound: 'No console cookie yet',
        queryFailed: 'Quota query failed',
        noWindows: 'This plan reports no usage windows.',
        openConsole: 'Open console & sign in',
        copyConsole: 'Copy console link',
        copied: 'Link copied ✓',
        autoLogin: 'Open browser & bind automatically',
        autoLoginHint: 'Opens your default browser at the console sign-in page. After you sign in there, the badge reads that browser’s cookies and binds itself. Once bound, later binds reuse the saved profile with no window.',
        autoChecking: 'Checking the saved sign-in…',
        autoWaiting: 'Waiting for you to sign in in the opened browser…',
        autoVerifying: 'Verifying the console sign-in…',
        autoBound: 'Bound ✓',
        autoTimeout: 'Timed out — try again',
        autoFailed: 'Automatic binding failed',
        autoCancel: 'Cancel',
        autoStarting: 'Starting the browser…',
        manualTitle: 'Or paste a cookie by hand',
        showManual: 'Show',
        hideManual: 'Hide',
        stepsTitle: 'How to bind',
        step1: 'Open the console in a browser and sign in.',
        step2: 'F12 → Network → reload → open any request → copy the whole “Cookie” request header.',
        step3: 'Paste it below; the badge verifies it against the console before storing it.',
        pasteLabel: 'Cookie request header',
        save: 'Save & verify',
        cancel: 'Cancel',
        saved: 'Bound ✓',
        pasteEmpty: 'Paste the cookie first',
        apiKeyNote: 'These plans reuse the API key already configured in Models — nothing to bind:',
        consoleNote: 'Console plans (one-time cookie bind)',
        refreshHint: 'Switch models to see the plan limits of the model in use.',
        w5h: 'Rolling',
        w1h: 'Hourly',
        w1d: 'Daily',
        w7d: 'Weekly',
        w30d: 'Monthly',
        w1y: 'Yearly',
        wBalance: 'Balance',
        wPlan: 'Plan',
        wOther: 'Window',
      },
      zh: {
        settingsNav: '额度徽章',
        windowsTitle: '额度限制',
        remaining: '剩余',
        used: '已用',
        resetsIn: '{duration}后重置',
        resetsAt: '重置 {time}',
        refreshedAt: '更新于 {time}',
        refresh: '刷新',
        loading: '加载中…',
        bind: '绑定',
        bindTitle: '绑定 {provider} 控制台',
        notBound: '尚未绑定控制台 Cookie',
        queryFailed: '额度查询失败',
        noWindows: '该套餐没有返回用量窗口。',
        openConsole: '打开控制台登录',
        copyConsole: '复制控制台地址',
        copied: '地址已复制 ✓',
        autoLogin: '浏览器登录并自动绑定',
        autoLoginHint: '会用你的默认浏览器打开控制台登录页。你在里面登录后，徽章直接读取那个浏览器的 Cookie 自动绑定。绑定过一次之后，以后再绑会复用已登录的浏览器配置，不用再开窗口。',
        autoChecking: '正在检查已保存的登录状态…',
        autoWaiting: '已打开浏览器，请在里面完成登录，完成后会自动绑定…',
        autoVerifying: '正在校验控制台登录状态…',
        autoBound: '已绑定 ✓',
        autoTimeout: '等待超时，请重试',
        autoFailed: '自动绑定失败',
        autoCancel: '取消',
        autoStarting: '正在启动浏览器…',
        manualTitle: '或者手动粘贴 Cookie',
        showManual: '展开',
        hideManual: '收起',
        stepsTitle: '绑定步骤',
        step1: '在浏览器打开控制台并登录。',
        step2: 'F12 → Network → 刷新页面 → 点任意请求 → 复制整段「Cookie」请求头。',
        step3: '粘贴到下面保存，徽章会先向控制台校验再保存。',
        pasteLabel: 'Cookie 请求头',
        save: '保存并校验',
        cancel: '取消',
        saved: '已绑定 ✓',
        pasteEmpty: '请先粘贴 Cookie',
        apiKeyNote: '以下套餐直接复用「模型设置」里已配好的 API Key，无需绑定：',
        consoleNote: '控制台类套餐（一次性绑定 Cookie）',
        refreshHint: '切换模型即可看到当前模型对应套餐的额度。',
        w5h: '滚动',
        w1h: '小时',
        w1d: '日',
        w7d: '周',
        w30d: '月',
        w1y: '年',
        wBalance: '余额',
        wPlan: '套餐',
        wOther: '窗口',
      },
    }
    DICTS['zh-CN'] = DICTS.zh

    const CONSOLE_PLANS = [
      {
        family: 'stepfun',
        title: 'StepFun',
        loginUrl: 'https://platform.stepfun.com/plan-subscribe',
        placeholder: 'Oasis-Webid=…; sessionid=…; …',
      },
      {
        family: 'mimo',
        title: '小米 MiMo',
        loginUrl: 'https://platform.xiaomimimo.com/',
        placeholder: 'api-platform_serviceToken=…; userId=…; …',
      },
    ]

    // Index of a window key to its locale label.
    const WINDOW_LABEL = {
      '5h': 'w5h',
      '1h': 'w1h',
      '1d': 'w1d',
      '7d': 'w7d',
      '30d': 'w30d',
      '1y': 'w1y',
      balance: 'wBalance',
      plan: 'wPlan',
      week: 'w7d',
      month: 'w30d',
    }

    // Ring geometry — identical to the composer's context meter (14px viewBox, 2px stroke).
    const RADIUS = 5.5
    const CIRCUMFERENCE = 2 * Math.PI * RADIUS

    const CSS = `
.qm-root{flex:none;display:inline-flex;order:1}
.qm-trigger{border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);font-family:inherit;
  font-size:var(--dsh-content-font-size-secondary,13px);font-variant-numeric:tabular-nums;
  line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));white-space:nowrap;cursor:pointer;
  background:0 0;border:none;flex:none;align-items:center;gap:6px;padding:1px 8px;display:inline-flex}
.qm-trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
@media (hover:hover){.qm-trigger:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}}
.qm-trigger.qm-static{cursor:default}
.qm-trigger.qm-static:hover{background:0 0;color:var(--dsw-alias-label-tertiary)}
.qm-track{fill:none;stroke:var(--dsw-alias-border-l3);stroke-width:2px}
.qm-fill{fill:none;stroke:var(--dsw-alias-label-tertiary);stroke-width:2px;stroke-linecap:round}
.qm-fill.qm-warn{stroke:var(--dsw-alias-state-warn-primary)}
.qm-fill.qm-bad{stroke:var(--dsw-alias-state-error-primary)}
.qm-val.qm-warn{color:var(--dsw-alias-state-warn-primary)}
.qm-val.qm-bad{color:var(--dsw-alias-state-error-primary)}
.qm-panel{z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);
  width:min(272px,100vw - 24px);backdrop-filter:var(--dsw-menu-backdrop-filter);
  --dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);
  color:var(--dsw-alias-label-secondary);cursor:default;border:0;padding:12px;font-size:12px;line-height:20px;
  position:fixed;overflow:hidden auto}
.qm-head{align-items:center;gap:6px;display:flex}
.qm-head-title{color:var(--dsw-alias-label-primary);font-weight:500}
.qm-head-sub{color:var(--dsw-alias-label-tertiary)}
.qm-head-fig{margin-left:auto;color:var(--dsw-alias-label-primary);font-weight:500;font-variant-numeric:tabular-nums}
.qm-bar{background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;height:4px;margin:10px 0 6px;display:flex;overflow:hidden}
.qm-bar-fill{border-radius:999px;flex:none;min-width:2px;height:100%;background:var(--meter-tint,var(--dsw-alias-label-tertiary))}
.qm-bar-fill.qm-warn{--meter-tint:var(--dsw-alias-state-warn-primary)}
.qm-bar-fill.qm-bad{--meter-tint:var(--dsw-alias-state-error-primary)}
.qm-rows{margin:6px 0 0;display:flex;flex-direction:column;gap:10px}
.qm-single-reset{margin-top:6px;display:flex;justify-content:space-between;gap:8px;color:var(--dsw-alias-label-tertiary);font-size:11px}
.qm-single-window{color:var(--dsw-alias-label-secondary)}
.qm-row{display:flex;flex-direction:column;gap:4px}
.qm-row-top{align-items:baseline;gap:6px;display:flex}
.qm-row-label{color:var(--dsw-alias-label-secondary)}
.qm-row-key{color:var(--dsw-alias-label-tertiary);font-size:11px}
.qm-row-reset{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap}
.qm-row-val{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);min-width:38px;text-align:right}
.qm-row-bar{background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;height:3px;display:flex;overflow:hidden}
.qm-row-fill{border-radius:999px;flex:none;min-width:2px;height:100%;background:var(--dsw-alias-label-tertiary)}
.qm-row-fill.qm-warn{background:var(--dsw-alias-state-warn-primary)}
.qm-row-fill.qm-bad{background:var(--dsw-alias-state-error-primary)}
.qm-foot{align-items:center;gap:8px;margin-top:10px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1);
  color:var(--dsw-alias-label-tertiary);font-size:11px;display:flex}
.qm-link{cursor:pointer;color:var(--dsw-alias-label-secondary);border:none;background:none;padding:2px 6px;
  border-radius:4px;font:inherit;font-size:11px}
.qm-link:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.qm-note{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px}
.qm-error{color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:18px;word-break:break-word}
.qm-ok{color:var(--dsw-alias-state-success-primary);font-size:11px}
.qm-overlay{position:fixed;inset:0;z-index:1300;background:var(--dsw-alias-bg-mask,rgba(0,0,0,.32));
  display:flex;align-items:center;justify-content:center;padding:24px}
.qm-modal{box-sizing:border-box;width:min(460px,100%);max-height:calc(100vh - 48px);overflow:auto;
  border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);
  box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);padding:18px 20px;
  display:flex;flex-direction:column;gap:12px;font-size:13px;line-height:20px}
.qm-modal-head{display:flex;align-items:center;gap:8px}
.qm-modal-title{font-weight:600;font-size:14px}
.qm-btn{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);
  border-radius:6px;padding:5px 12px;font:inherit;font-size:12px;cursor:pointer}
.qm-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.qm-btn[disabled]{opacity:.55;cursor:default}
.qm-btn.qm-primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}
.qm-btnrow{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.qm-ta{width:100%;box-sizing:border-box;min-height:74px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;
  padding:8px;font:inherit;font-size:12px;line-height:18px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);resize:vertical}
.qm-ta:focus{outline:none;border-color:var(--dsw-alias-border-l2)}
.qm-set{display:flex;flex-direction:column;gap:14px;font-size:13px;color:var(--dsw-alias-label-primary);max-width:640px}
.qm-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.qm-card-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
.qm-card-title{font-weight:600}
.qm-sec{font-weight:600;margin-top:4px}
.qm-mini{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.qm-login{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);
  border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
`

    // ── helpers ─────────────────────────────────────────────────────────

    function formatDuration (ms) {
      if (!Number.isFinite(ms) || ms < 0) return ''
      const minutes = Math.round(ms / 60000)
      if (minutes < 1) return '<1m'
      if (minutes < 60) return `${minutes}m`
      const hours = Math.floor(minutes / 60)
      if (hours < 48) return `${hours}h${minutes % 60 > 0 ? `${minutes % 60}m` : ''}`
      return `${Math.floor(hours / 24)}d${hours % 24 > 0 ? `${hours % 24}h` : ''}`
    }

    function formatTime (epochMs) {
      if (!Number.isFinite(epochMs)) return ''
      try {
        return new Date(epochMs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      } catch {
        return ''
      }
    }

    function remainingOf (win) {
      if (win === null || win === undefined) return null
      if (win.percent === null || win.percent === undefined) return null
      return Math.max(0, Math.min(100, Math.round((100 - Number(win.percent)) * 10) / 10))
    }

    function toneOf (remaining) {
      if (remaining === null) return ''
      return remaining <= 10 ? 'qm-bad' : remaining <= 30 ? 'qm-warn' : ''
    }

    function percentWindows (data) {
      return (data?.windows ?? []).filter((w) => w !== null && typeof w === 'object' && remainingOf(w) !== null)
    }

    function textWindows (data) {
      return (data?.windows ?? []).filter((w) => w !== null && typeof w === 'object' && typeof w.text === 'string' && w.text.length > 0)
    }

    const PERIOD_MINUTES = { m: 1, h: 60, d: 1440, w: 10080, y: 525600 }
    const PERIOD_ALIASES = { week: 10080, month: 43200, year: 525600, day: 1440, hour: 60, minute: 1 }

    /** Length of a window's refresh period, in minutes; unknown keys sort last. */
    function periodMinutes (key) {
      const text = String(key ?? '').trim().toLowerCase()
      if (PERIOD_ALIASES[text] !== undefined) return PERIOD_ALIASES[text]
      const match = /^(\d+)\s*([mhdwy])$/.exec(text)
      if (match === null) return Number.POSITIVE_INFINITY
      return Number(match[1]) * (PERIOD_MINUTES[match[2]] ?? Number.POSITIVE_INFINITY)
    }

    /**
     * The window that refreshes most often — the one the compact ring reports.
     * A 5h bucket says more about "can I keep working right now" than a 30d one.
     */
    function primaryWindow (windows) {
      if (windows.length === 0) return null
      return windows.reduce((best, win) => (periodMinutes(win.key) < periodMinutes(best.key) ? win : best))
    }

    function windowLabel (key, t) {
      const id = WINDOW_LABEL[key]
      return id === undefined ? t('wOther') : t(id)
    }

    function resetText (win) {
      if (win === null || win === undefined || win.resetsAt === null || win.resetsAt === undefined) return ''
      const at = Date.parse(win.resetsAt)
      if (!Number.isFinite(at)) return ''
      return formatDuration(at - Date.now())
    }

    /** Absolute clock/date of a reset: time today, `MM-DD HH:mm` this year, else full date. */
    function formatResetDate (epochMs) {
      const at = new Date(epochMs)
      const now = new Date()
      const pad = (value) => String(value).padStart(2, '0')
      const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`
      if (at.toDateString() === now.toDateString()) return clock
      const day = `${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
      if (at.getFullYear() === now.getFullYear()) return `${day} ${clock}`
      return `${at.getFullYear()}-${day} ${clock}`
    }

    /**
     * Reset label for a row: a countdown while the reset is inside a day (where
     * "34m" beats a clock reading), an absolute date once it is further out
     * (where "2027-10-23" is what the console actually promises).
     */
    function resetLabel (win, t) {
      if (win === null || win === undefined || win.resetsAt === null || win.resetsAt === undefined) return ''
      const at = Date.parse(win.resetsAt)
      if (!Number.isFinite(at)) return ''
      const remaining = at - Date.now()
      if (remaining < 86_400_000) return t('resetsIn', { duration: formatDuration(remaining) })
      return t('resetsAt', { time: formatResetDate(at) })
    }

    function openExternal (url) {
      try {
        const win = window.open(url, '_blank', 'noopener,noreferrer')
        if (win !== null) { try { win.opener = null } catch { /* ignore */ } }
        return true
      } catch {
        return false
      }
    }

    async function copyText (text) {
      try {
        if (navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch { /* fall through */ }
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand('copy')
        area.remove()
        return ok
      } catch {
        return false
      }
    }

    // ── data ────────────────────────────────────────────────────────────

    function useJson (url, tick) {
      const [state, setState] = React.useState({ status: 'loading' })
      React.useEffect(() => {
        if (url === null) return undefined
        let alive = true
        setState((prev) => (prev.url === url && prev.status !== 'loading' ? prev : { status: 'loading', url }))
        fetch(url, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
          .then((data) => { if (alive) setState({ ...data, url }) })
          .catch((error) => { if (alive) setState({ status: 'error', message: String(error?.message ?? error), windows: [], url }) })
        return () => { alive = false }
      }, [url, tick])
      return state
    }

    // ── primitives ──────────────────────────────────────────────────────

    function RingMark ({ percent, tone }) {
      const p = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0))
      return h('svg', { viewBox: '0 0 14 14', width: 14, height: 14, 'aria-hidden': true },
        h('circle', { className: 'qm-track', cx: 7, cy: 7, r: RADIUS }),
        h('circle', {
          className: `qm-fill ${tone}`.trim(),
          cx: 7,
          cy: 7,
          r: RADIUS,
          strokeDasharray: `${(CIRCUMFERENCE * p) / 100} ${CIRCUMFERENCE}`,
          transform: 'rotate(-90 7 7)',
        }))
    }

    function useDismiss (active, anchorRef, panelRef, onClose) {
      React.useEffect(() => {
        if (!active) return undefined
        const onPointer = (event) => {
          const target = event.target
          if (anchorRef.current !== null && anchorRef.current.contains(target)) return
          if (panelRef.current !== null && panelRef.current.contains(target)) return
          onClose()
        }
        const onKey = (event) => {
          if (event.key === 'Escape') { event.stopPropagation(); onClose() }
        }
        document.addEventListener('pointerdown', onPointer, true)
        document.addEventListener('keydown', onKey, true)
        return () => {
          document.removeEventListener('pointerdown', onPointer, true)
          document.removeEventListener('keydown', onKey, true)
        }
      }, [active, anchorRef, panelRef, onClose])
    }

    // ── quota panel ─────────────────────────────────────────────────────

    function QuotaPanel ({ data, t, anchorRef, panelRef, onRefresh, onClose, onBind }) {
      const [position, setPosition] = React.useState(null)
      React.useLayoutEffect(() => {
        const measure = () => {
          const anchor = anchorRef.current
          if (anchor === null) return
          const rect = anchor.getBoundingClientRect()
          const width = panelRef.current?.offsetWidth ?? 272
          const height = panelRef.current?.offsetHeight ?? 190
          const margin = 12
          const gap = 8
          const left = Math.max(margin, Math.min(rect.right - width, window.innerWidth - width - margin))
          let top = rect.top - height - gap
          if (top < margin) top = Math.min(rect.bottom + gap, window.innerHeight - height - margin)
          setPosition({ left, top: Math.max(margin, top) })
        }
        measure()
        window.addEventListener('resize', measure)
        report('panel-render', `${data.providerLabel ?? data.provider ?? '-'} status=${data.status} windows=${(data.windows ?? []).length}`)
        return () => window.removeEventListener('resize', measure)
      }, [anchorRef, panelRef, data])

      const windows = percentWindows(data)
      const primary = primaryWindow(windows)
      const remaining = remainingOf(primary)
      const tone = toneOf(remaining)

      const rows = windows.map((win) => {
        const left = remainingOf(win)
        const reset = resetLabel(win, t)
        return h('div', { className: 'qm-row', key: win.key },
          h('div', { className: 'qm-row-top' },
            h('span', { className: 'qm-row-label' }, windowLabel(win.key, t)),
            h('span', { className: 'qm-row-key' }, win.key),
            reset !== '' ? h('span', { className: 'qm-row-reset' }, reset) : null,
            h('span', { className: `qm-row-val ${toneOf(left)}`.trim() }, `${Math.round(left)}%`),
          ),
          h('div', { className: 'qm-row-bar' }, h('div', {
            className: `qm-row-fill ${toneOf(left)}`.trim(),
            style: { width: `${left}%` },
          })),
        )
      })

      const texts = textWindows(data).map((win) => h('div', { className: 'qm-row', key: win.key },
        h('div', { className: 'qm-row-top' },
          h('span', { className: 'qm-row-label' }, windowLabel(win.key, t)),
          h('span', { className: 'qm-row-val' }, win.text),
        ),
      ))

      let body = null
      if (data.status === 'loading') {
        body = h('div', { className: 'qm-note' }, t('loading'))
      } else if (data.status === 'no-credential') {
        body = h('div', { className: 'qm-query' },
          h('div', { className: 'qm-note' }, String(data.message ?? t('notBound'))),
          h('div', { className: 'qm-btnrow', style: { marginTop: '10px' } },
            typeof data.setupFamily === 'string'
              ? h('button', { type: 'button', className: 'qm-btn qm-primary', onClick: () => onBind(data.setupFamily) }, t('bind'))
              : null,
            h('button', { type: 'button', className: 'qm-btn', onClick: onRefresh }, t('refresh')),
          ))
      } else if (data.status === 'error') {
        body = h('div', null,
          h('div', { className: 'qm-error' }, String(data.message ?? t('queryFailed'))),
          h('div', { className: 'qm-btnrow', style: { marginTop: '10px' } },
            h('button', { type: 'button', className: 'qm-btn', onClick: onRefresh }, t('refresh')),
          ))
      } else if (windows.length === 0 && texts.length === 0) {
        body = h('div', { className: 'qm-note' }, t('noWindows'))
      } else {
        // One window is already fully described by the header reading and the
        // bar, so repeating "月 30d … 99%" underneath is noise; only the reset
        // countdown carries new information.
        const single = windows.length === 1 ? windows[0] : null
        const singleReset = single === null ? '' : resetLabel(single, t)
        body = h(React.Fragment, null,
          // With per-window rows below, a summary bar would just repeat the
          // monthly row; it only earns its place when it is the sole reading.
          single !== null
            ? h('div', { className: 'qm-bar' }, h('div', {
                className: `qm-bar-fill ${tone}`.trim(),
                style: { width: `${remaining ?? 0}%` },
              }))
            : null,
          singleReset !== ''
            ? h('div', { className: 'qm-single-reset' }, h('span', null, singleReset))
            : null,
          windows.length > 1 ? h('div', { className: 'qm-rows' }, rows) : null,
          texts.length > 0 ? h('div', { className: 'qm-rows' }, texts) : null)
      }

      return createPortal(h('div', {
        ref: panelRef,
        className: 'qm-panel',
        role: 'dialog',
        'aria-label': t('windowsTitle'),
        style: position ?? { visibility: 'hidden', left: 0, top: 0 },
      },
      h('div', { className: 'qm-head' },
        h('span', { className: 'qm-head-title' }, String(data.providerLabel ?? data.family ?? data.provider ?? '')),
        h('span', { className: 'qm-head-sub' }, t('windowsTitle')),
        remaining !== null
          ? h('span', { className: 'qm-head-fig' }, `${t('remaining')} ${Math.round(remaining)}%`)
          : null,
      ),
      body,
      h('div', { className: 'qm-foot' },
        h('span', null, data.fetchedAt !== undefined ? t('refreshedAt', { time: formatTime(data.fetchedAt) }) : t('loading')),
        h('button', { type: 'button', className: 'qm-link', onClick: onRefresh }, t('refresh')),
      )), document.body)
    }

    // ── browser login capture (client side) ─────────────────────────────

    const LOGIN_PHASE_KEY = {
      starting: 'autoStarting',
      checking: 'autoChecking',
      waiting: 'autoWaiting',
      verifying: 'autoVerifying',
      bound: 'autoBound',
      timeout: 'autoTimeout',
      error: 'autoFailed',
      cancelled: 'autoCancel',
    }

    function loginPhaseText (state, t) {
      const key = LOGIN_PHASE_KEY[state?.phase]
      if (key !== undefined) return t(key)
      return String(state?.message ?? '')
    }

    /**
     * Drive the Host half's browser-login capture: start it, then poll its
     * phase until it binds or stops. The browser is opened by the Host, so the
     * page only needs this small state machine.
     */
    function useLoginFlow (plan, t, onBound) {
      const [state, setState] = React.useState({ phase: 'idle' })
      const timerRef = React.useRef(0)
      const stopPolling = React.useCallback(() => {
        if (timerRef.current !== 0) {
          window.clearTimeout(timerRef.current)
          timerRef.current = 0
        }
      }, [])
      React.useEffect(() => stopPolling, [stopPolling])
      const poll = React.useCallback(() => {
        fetch(`${LOGIN_URL}/status?family=${encodeURIComponent(plan.family)}`, {
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
        })
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
          .then((data) => {
            setState(data)
            if (data.phase === 'bound') {
              report('login-bound', plan.family)
              onBound()
              return
            }
            if (data.phase === 'timeout' || data.phase === 'error' || data.phase === 'cancelled' || data.phase === 'idle') return
            timerRef.current = window.setTimeout(poll, 1500)
          })
          .catch(() => { timerRef.current = window.setTimeout(poll, 2500) })
      }, [plan.family, onBound])
      const start = React.useCallback(() => {
        stopPolling()
        setState({ phase: 'starting' })
        fetch(`${LOGIN_URL}/start?family=${encodeURIComponent(plan.family)}&mode=auto`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
        })
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
          .then((data) => {
            setState(data)
            report('login-start', `${plan.family} ${data.phase} ${data.message ?? ''}`)
            timerRef.current = window.setTimeout(poll, 900)
          })
          .catch((error) => setState({ phase: 'error', message: String(error?.message ?? error) }))
      }, [plan.family, poll, stopPolling])
      const cancel = React.useCallback(() => {
        stopPolling()
        fetch(`${LOGIN_URL}/cancel?family=${encodeURIComponent(plan.family)}`, { method: 'POST', credentials: 'same-origin' }).catch(() => {})
        setState({ phase: 'cancelled' })
      }, [plan.family, stopPolling])
      return { state, start, cancel, phaseText: loginPhaseText(state, t) }
    }

    /**
     * Watch a running browser-login capture from the badge itself, so a session
     * started from the settings page (or left running after the modal closed)
     * still flips the badge from 🔒 to real numbers.
     */
    function useLoginWatch (family, active, onBound) {
      React.useEffect(() => {
        if (active !== true || typeof family !== 'string') return undefined
        let alive = true
        let timer = 0
        const tick = () => {
          fetch(`${LOGIN_URL}/status?family=${encodeURIComponent(family)}`, {
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
          })
            .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
            .then((data) => {
              if (!alive) return
              if (data.phase === 'bound') { onBound(); return }
              if (data.phase === 'starting' || data.phase === 'checking' || data.phase === 'waiting' || data.phase === 'verifying') {
                timer = window.setTimeout(tick, 4000)
              }
            })
            .catch(() => { if (alive) timer = window.setTimeout(tick, 8000) })
        }
        tick()
        return () => {
          alive = false
          if (timer !== 0) window.clearTimeout(timer)
        }
      }, [family, active, onBound])
    }

    // ── bind form ───────────────────────────────────────────────────────

    function BindForm ({ plan, t, onBound, autoFocus }) {
      const [cookie, setCookie] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [message, setMessage] = React.useState(null)
      const [copied, setCopied] = React.useState(false)
      const [manual, setManual] = React.useState(false)
      const ref = React.useRef(null)
      const login = useLoginFlow(plan, t, onBound)

      React.useEffect(() => {
        if (autoFocus !== true || manual) return
        ref.current?.focus()
      }, [autoFocus, manual])

      const save = () => {
        const value = cookie.trim()
        if (value.length === 0) { setMessage({ error: t('pasteEmpty') }); return }
        setBusy(true)
        setMessage(null)
        fetch(`${SETUP_URL}?family=${encodeURIComponent(plan.family)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ cookie: value }),
        })
          .then((response) => response.json())
          .then((data) => {
            if (data.status === 'ok') {
              setCookie('')
              setMessage({ ok: true })
              onBound()
            } else {
              setMessage({ error: String(data.message ?? 'invalid cookie') })
            }
          })
          .catch((error) => setMessage({ error: String(error?.message ?? error) }))
          .finally(() => setBusy(false))
      }

      const copy = () => {
        copyText(plan.loginUrl).then((ok) => {
          if (!ok) return
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1800)
        })
      }

      const loginPhase = login.state.phase
      const loginActive = loginPhase === 'starting' || loginPhase === 'checking' || loginPhase === 'waiting' || loginPhase === 'verifying'
      const loginTone = loginPhase === 'bound' ? 'qm-ok' : loginPhase === 'timeout' || loginPhase === 'error' ? 'qm-error' : 'qm-mini'

      const manualBlock = manual
        ? h(React.Fragment, null,
            h('div', { className: 'qm-note' }, t('stepsTitle')),
            h('div', { className: 'qm-mini' }, t('step1')),
            h('div', { className: 'qm-mini' }, t('step2')),
            h('div', { className: 'qm-mini' }, t('step3')),
            h('div', { className: 'qm-btnrow' },
              h('button', { type: 'button', className: 'qm-btn', onClick: () => openExternal(plan.loginUrl) }, t('openConsole')),
              h('button', { type: 'button', className: 'qm-btn', onClick: copy }, copied ? t('copied') : t('copyConsole')),
            ),
            h('div', { className: 'qm-note' }, t('pasteLabel')),
            h('textarea', {
              ref,
              className: 'qm-ta',
              value: cookie,
              placeholder: plan.placeholder,
              spellCheck: false,
              onChange: (event) => { setCookie(event.target.value); setMessage(null) },
            }),
            h('div', { className: 'qm-btnrow' },
              h('button', { type: 'button', className: 'qm-btn qm-primary', onClick: save, disabled: busy }, busy ? t('loading') : t('save')),
              message?.ok === true ? h('span', { className: 'qm-ok' }, t('saved')) : null,
              typeof message?.error === 'string' ? h('span', { className: 'qm-error' }, message.error) : null,
            ),
          )
        : null

      return h(React.Fragment, null,
        h('div', { className: 'qm-login' },
          h('div', { className: 'qm-mini' }, t('autoLoginHint')),
          h('div', { className: 'qm-btnrow' },
            h('button', {
              type: 'button',
              className: 'qm-btn qm-primary',
              onClick: login.start,
              disabled: loginActive,
            }, loginActive ? login.phaseText : t('autoLogin')),
            loginActive ? h('button', { type: 'button', className: 'qm-btn', onClick: login.cancel }, t('autoCancel')) : null,
          ),
          loginPhase !== 'idle'
            ? h('div', { className: loginTone }, login.phaseText)
            : null,
          login.state?.lastError !== null && login.state?.lastError !== undefined && loginPhase !== 'bound'
            ? h('div', { className: 'qm-note' }, `控制台返回：${login.state.lastError}`)
            : null,
        ),
        h('div', { className: 'qm-btnrow' },
          h('button', { type: 'button', className: 'qm-link', onClick: () => setManual((value) => !value) },
            manual ? t('hideManual') : `${t('manualTitle')} · ${t('showManual')}`),
        ),
        manualBlock,
      )
    }

    function BindModal ({ plan, t, onClose, onBound }) {
      const dialogRef = React.useRef(null)
      const anchorRef = React.useRef(null)
      useDismiss(true, anchorRef, dialogRef, onClose)
      React.useEffect(() => {
        report('bind-render', plan.family)
        const previous = document.activeElement
        return () => { try { previous?.focus?.() } catch { /* ignore */ } }
      }, [])
      return createPortal(h('div', {
        className: 'qm-overlay',
        onPointerDown: (event) => { if (event.target === event.currentTarget) onClose() },
      },
      h('div', {
        ref: dialogRef,
        className: 'qm-modal',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': t('bindTitle', { provider: plan.title }),
      },
      h('div', { className: 'qm-modal-head' },
        h('span', { className: 'qm-modal-title' }, t('bindTitle', { provider: plan.title })),
      ),
      h(BindForm, { plan, t, autoFocus: true, onBound: () => { onBound(); onClose() } }),
      h('div', { className: 'qm-btnrow' },
        h('button', { type: 'button', className: 'qm-btn', onClick: onClose }, t('cancel')),
      ),
      )), document.body)
    }

    // ── composer badge ──────────────────────────────────────────────────

    function QuotaBadge (props) {
      const { useProjection, t } = props
      const triggerRef = React.useRef(null)
      const panelRef = React.useRef(null)
      const rootRef = React.useRef(null)
      const [open, setOpen] = React.useState(false)
      const [bindFamily, setBindFamily] = React.useState(null)
      const [tick, setTick] = React.useState(0)

      const selection = useProjection('modelSelection')
      const picked = selection?.next ?? selection?.current ?? selection?.lastUsed
      const provider = typeof picked?.provider === 'string' ? picked.provider : undefined
      const model = typeof picked?.model === 'string' ? picked.model : undefined
      const url = provider === undefined
        ? null
        : `${QUOTA_URL}?provider=${encodeURIComponent(provider)}${model === undefined ? '' : `&model=${encodeURIComponent(model)}`}`
      const data = useJson(url, tick)

      React.useEffect(() => {
        if (provider === undefined) return
        report('badge-fetch', `${provider}/${model ?? '-'} status=${data.status} windows=${(data.windows ?? []).length}${data.message === undefined ? '' : ` msg=${data.message}`}`)
      }, [provider, model, data.status])

      React.useEffect(() => {
        report('selection', `${provider ?? 'none'} / ${model ?? '-'} shape=${JSON.stringify(selection ?? null).slice(0, 240)}`)
      }, [provider, model])

      React.useEffect(() => {
        if (open) report('panel-open', `${provider}/${model}`)
      }, [open])

      React.useEffect(() => {
        if (bindFamily !== null) report('bind-open', bindFamily)
      }, [bindFamily])

      React.useEffect(() => {
        const timer = window.setInterval(() => setTick((n) => n + 1), REFRESH_MS)
        return () => window.clearInterval(timer)
      }, [])

      React.useEffect(() => { setOpen(false); setBindFamily(null) }, [provider])

      const close = React.useCallback(() => setOpen(false), [])
      const refresh = React.useCallback(() => setTick((n) => n + 1), [])
      useDismiss(open, triggerRef, panelRef, close)
      useDockTrailingOrder(rootRef)
      useLoginWatch(
        typeof data.setupFamily === 'string' ? data.setupFamily : null,
        data.status === 'no-credential',
        refresh,
      )

      if (provider === undefined || data.status === 'unsupported') {
        return h('style', null, CSS)
      }

      const windows = percentWindows(data)
      const texts = textWindows(data)
      const primary = primaryWindow(windows)
      const remaining = remainingOf(primary)
      const tone = toneOf(remaining)
      const boundPlan = CONSOLE_PLANS.find((plan) => plan.family === bindFamily)

      let trigger = null
      if (data.status === 'ok' && (windows.length > 0 || texts.length > 0)) {
        const label = windows.length > 0
          ? `${Math.round(remaining)}%`
          : String(texts[0].text)
        const title = [
          String(data.providerLabel ?? provider),
          primary === null ? '' : `${windowLabel(primary.key, t)} ${primary.key}`,
          windows.length > 0 ? `${t('remaining')} ${Math.round(remaining)}%` : '',
        ].filter((part) => part.length > 0).join(' · ')
        // Every badge opens: even one window has a reset date worth reading.
        const expandable = windows.length + texts.length > 0
        trigger = h('button', {
          ref: triggerRef,
          type: 'button',
          className: `qm-trigger${expandable ? '' : ' qm-static'}`,
          title,
          'aria-label': title,
          'aria-haspopup': expandable ? 'dialog' : undefined,
          'aria-expanded': expandable ? open : undefined,
          onClick: expandable ? () => setOpen((value) => !value) : undefined,
        },
        windows.length > 0 ? h(RingMark, { percent: remaining, tone }) : null,
        h('span', { className: `qm-val ${tone}`.trim() }, label))
      } else if (data.status === 'no-credential') {
        const family = typeof data.setupFamily === 'string' ? data.setupFamily : null
        const plan = CONSOLE_PLANS.find((candidate) => candidate.family === family)
        trigger = h('button', {
          ref: triggerRef,
          type: 'button',
          className: 'qm-trigger',
          title: String(data.message ?? t('notBound')),
          onClick: () => { if (plan !== undefined) setBindFamily(family); else setOpen(true) },
        },
        h(RingMark, { percent: 0, tone: '' }),
        h('span', null, `🔒 ${t('bind')}`))
      } else if (data.status === 'error') {
        trigger = h('button', {
          ref: triggerRef,
          type: 'button',
          className: 'qm-trigger',
          title: `${t('queryFailed')}: ${String(data.message ?? '')}`,
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          onClick: () => setOpen((value) => !value),
        },
        h(RingMark, { percent: 0, tone: 'qm-bad' }),
        h('span', { className: 'qm-val qm-bad' }, '!'))
      } else {
        trigger = h('button', {
          ref: triggerRef,
          type: 'button',
          className: 'qm-trigger qm-static',
          title: String(data.providerLabel ?? provider),
        },
        h(RingMark, { percent: 0, tone: '' }),
        h('span', null, '…'))
      }

      return h(React.Fragment, null,
        h('style', null, CSS),
        h('span', { className: 'qm-root', ref: rootRef }, trigger),
        open ? h(QuotaPanel, {
          data,
          t,
          anchorRef: triggerRef,
          panelRef,
          onRefresh: refresh,
          onClose: close,
          onBind: (family) => { setOpen(false); setBindFamily(family) },
        }) : null,
        boundPlan !== undefined ? h(BindModal, {
          plan: boundPlan,
          t,
          onClose: () => setBindFamily(null),
          onBound: refresh,
        }) : null,
      )
    }

    // ── settings section ────────────────────────────────────────────────

    function ConsoleCard ({ plan, t }) {
      const [nonce, setNonce] = React.useState(0)
      const data = useJson(`${QUOTA_URL}?family=${encodeURIComponent(plan.family)}`, nonce)
      let status = h('span', { className: 'qm-note' }, t('loading'))
      if (data.status === 'ok') {
        const rows = percentWindows(data).map((win) => `${windowLabel(win.key, t)} ${Math.round(remainingOf(win))}%`)
        status = h('span', { className: 'qm-ok' }, `✓ ${rows.join(' · ') || 'ok'}`)
      } else if (data.status === 'no-credential') {
        status = h('span', { className: 'qm-note' }, t('notBound'))
      } else if (data.status === 'error') {
        status = h('span', { className: 'qm-error' }, String(data.message ?? t('queryFailed')))
      }
      return h('div', { className: 'qm-card' },
        h('div', { className: 'qm-card-head' },
          h('span', { className: 'qm-card-title' }, plan.title),
          status,
        ),
        h(BindForm, { plan, t, onBound: () => setNonce((n) => n + 1) }),
      )
    }

    function makeSettingsSection (t) {
      return function QuotaSettingsSection () {
        return h(Boundary, { channel: 'settings' },
          h('div', { className: 'qm-set' },
            h('style', null, CSS),
            h('div', { className: 'qm-sec' }, t('consoleNote')),
            CONSOLE_PLANS.map((plan) => h(ConsoleCard, { key: plan.family, plan, t })),
            h('div', { className: 'qm-sec' }, t('apiKeyNote')),
            h('div', { className: 'qm-mini' },
              'MiniMax · Kimi · OpenCode Go — 徽章显示刷新周期最短的那一档额度（有滚动就显示滚动，没有滚动才退到周 / 月）。'),
            h('div', { className: 'qm-mini' }, t('refreshHint')),
          ))
      }
    }    /**
     * The composer dock renders its slot *before* the built-in context meter, so
     * a plain slot entry always lands on that ring's left. Flex `order` is the
     * one lever we own: push our own dock child after everything else, which
     * puts the badge on the context meter's right.
     */
    function useDockTrailingOrder (rootRef) {
      React.useLayoutEffect(() => {
        const node = rootRef.current
        if (node === null || typeof node.closest !== 'function') return undefined
        const dock = node.closest('[data-composer-dock]')
        if (dock === null) return undefined
        let child = node
        while (child.parentElement !== null && child.parentElement !== dock) child = child.parentElement
        if (child.parentElement !== dock) return undefined
        const previous = child.style.order
        child.style.order = '1'
        return () => { child.style.order = previous }
      }, [rootRef])
    }

    // ── plugin ──────────────────────────────────────────────────────────

    return {
      inject: ['slots', 'locale'],
      apply (ctx) {
        report('apply', `entered ns=${NS}`)
        try {
          for (const [locale, dict] of Object.entries(DICTS)) {
            try { ctx.effect(() => ctx.locale.register(NS, locale, dict)) } catch { /* unsupported locale id */ }
          }
          const t = ctx.locale.bind(NS)
          // Ambient row under the composer, immediately before the context meter.
          ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
            name: 'conversation.composer.dock',
            id: 'quota-meter',
            order: 50,
            label: () => t('settingsNav'),
          }, (entryProps) => h(Boundary, { channel: 'badge' }, h(QuotaBadge, { ...entryProps, t }))))
          // A tab of Settings → Plugins, beside the shipped plugin list.
          ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
            name: 'settings.plugins.tab',
            id: 'quota-meter',
            order: 30,
            label: () => t('settingsNav'),
          }, makeSettingsSection(t)))
          report('apply', 'registered conversation.composer.dock + settings.plugins.tab')
        } catch (error) {
          report('apply-error', String(error?.stack ?? error))
          throw error
        }
      },
    }
  },
})
