/**
 * ARC Glasshouse — UV Lighting & Irrigation scheduler (Units 1–10)
 *
 * Every value on screen comes from the JACE through api.js (readSchedulePoint /
 * writeSchedulePoint). There is no mock fallback and no browser-side timer that
 * pretends a device is running. If a point cannot be read, the real error is shown.
 *
 * What the JACE value MEANS is detected from the value itself, never assumed:
 *   - boolean-like value            -> schedule enable/disable only
 *   - "HH:MM-HH:MM" style string    -> schedule window (start/stop), overnight aware
 *   - anything else                 -> shown raw, writes disabled (format unconfirmed)
 */
(function (root) {
    'use strict'

    const UNITS = 10
    const POLL_MS = 10000

    // ───────────────────────── pure logic (unit-tested) ─────────────────────────

    function parseHHMM(s) {
        const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(s).trim())
        if (!m) return null
        const h = +m[1], mi = +m[2]
        return h > 23 || mi > 59 ? null : h * 60 + mi
    }

    function fmtHHMM(min) {
        return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0')
    }

    const WINDOW_RE = /^\s*(\d{1,2}:\d{2})(?::\d{2})?(\s*(?:-|–|→|to)\s*)(\d{1,2}:\d{2})(?::\d{2})?\s*$/i

    // Only recognises a window if the JACE value already IS one. Returns null otherwise.
    function parseWindowValue(raw) {
        if (typeof raw !== 'string') return null
        const m = WINDOW_RE.exec(raw)
        if (!m) return null
        const startMin = parseHHMM(m[1]), stopMin = parseHHMM(m[3])
        if (startMin === null || stopMin === null) return null
        return { startMin, stopMin, sep: m[2] }
    }

    function formatWindowValue(startMin, stopMin, sep) {
        return fmtHHMM(startMin) + sep + fmtHHMM(stopMin)
    }

    // Start 12:00 / Stop 04:00 => overnight: runs 12:00 today -> 04:00 tomorrow.
    function isOvernight(startMin, stopMin) { return stopMin < startMin }

    function inWindow(startMin, stopMin, nowMin) {
        if (startMin === stopMin) return false
        return isOvernight(startMin, stopMin)
            ? (nowMin >= startMin || nowMin < stopMin)
            : (nowMin >= startMin && nowMin < stopMin)
    }

    function minuteOfDay(date) { return date.getHours() * 60 + date.getMinutes() }

    function atMinute(base, min, dayOffset) {
        const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, Math.floor(min / 60), min % 60, 0, 0)
        return d
    }

    // Next start (if outside window) or next stop (if inside), evaluated in local time.
    function nextEvent(startMin, stopMin, now) {
        const inside = inWindow(startMin, stopMin, minuteOfDay(now))
        const min = inside ? stopMin : startMin
        let at = atMinute(now, min, 0)
        if (at <= now) at = atMinute(now, min, 1)
        return { type: inside ? 'stop' : 'start', at, inside }
    }

    function describeEvent(ev, now) {
        const sameDay = ev.at.toDateString() === now.toDateString()
        return `${ev.type === 'start' ? 'Start' : 'Stop'} ${fmtHHMM(minuteOfDay(ev.at))} (${sameDay ? 'today' : 'tomorrow'})`
    }

    // true / false / null (unrecognised)
    function classifyBool(v) {
        if (typeof v === 'boolean') return v
        if (typeof v === 'number') return v === 0 ? false : v === 1 ? true : null
        if (typeof v === 'string') {
            const s = v.trim().toLowerCase().split(/[\s{]/)[0]
            if (['true', 'on', 'active', 'open', 'opened', 'enabled', '1'].includes(s)) return true
            if (['false', 'off', 'inactive', 'closed', 'disabled', '0'].includes(s)) return false
        }
        return null
    }

    // What kind of value is this schedule point holding?
    function interpretSchedule(read) {
        if (!read || !read.ok) return { kind: 'error' }
        const win = parseWindowValue(read.value)
        if (win) return { kind: 'window', ...win }
        const b = classifyBool(read.value)
        if (b !== null) return { kind: 'bool', enabled: b }
        return { kind: 'unknown' }
    }

    // UV: confirmed on-site 2026-09-28 — there is no separate LightSch_n schedule/window
    // point on the JACE. The only point that exists is a single per-unit on/off point
    // (UNITn_LIGHT), the same one the existing Manual ON/OFF toggle already writes to.
    // So this reads/writes that point directly: it IS the light, not a schedule for it.
    function deriveUvStatus(read) {
        const out = { status: 'error', label: 'Error / unavailable', notes: [], next: null }
        if (!read || !read.ok) { out.error = read && read.error; return out }
        const b = classifyBool(read.value)
        if (b === null) { out.status = 'unconfirmed'; out.label = 'Unconfirmed value'; out.notes.push(`Value not recognised as on/off: ${JSON.stringify(read.value)}`); return out }
        out.status = b ? 'running' : 'off'
        out.label = b ? 'ON' : 'OFF'
        out.enabled = b
        return out
    }

    function valveState(read) {
        if (!read || !read.ok) return { state: 'error' }
        const b = classifyBool(read.value)
        return b === null ? { state: 'unknown' } : { state: b ? 'open' : 'closed' }
    }

    function deriveIrrigationStatus(schedRead, valveRead, now) {
        const s = interpretSchedule(schedRead)
        const v = valveState(valveRead)
        const out = { status: 'error', label: 'Error / unavailable', notes: [], schedule: s, valve: v, next: null, discrepancy: null }
        if (s.kind === 'window') out.next = nextEvent(s.startMin, s.stopMin, now)

        if (s.kind === 'error' || v.state === 'error') {
            out.error = [s.kind === 'error' && schedRead.error, v.state === 'error' && valveRead.error].filter(Boolean).join(' ')
            return out
        }
        if (s.kind === 'unknown' || v.state === 'unknown') {
            out.status = 'unconfirmed'; out.label = 'Unconfirmed value'
            if (v.state === 'unknown') out.notes.push(`VALVE state value not recognised: ${JSON.stringify(valveRead.value)}`)
            return out
        }
        const disabled = s.kind === 'bool' && !s.enabled
        const shouldBeOpen = s.kind === 'window' ? out.next.inside : null

        if (v.state === 'open') {
            out.status = 'running'; out.label = 'Running'
            if (disabled) out.discrepancy = 'Valve is OPEN while the schedule is disabled.'
            else if (shouldBeOpen === false) out.discrepancy = 'Valve is OPEN outside the scheduled window.'
            return out
        }
        // valve closed
        if (disabled) { out.status = 'disabled'; out.label = 'Disabled'; return out }
        if (shouldBeOpen === true) {
            out.status = 'scheduled'; out.label = 'Scheduled'
            out.discrepancy = 'Inside the scheduled window but the valve reports CLOSED.'
            return out
        }
        if (shouldBeOpen === false) { out.status = 'scheduled'; out.label = 'Scheduled'; return out }
        out.status = 'off'; out.label = 'Off'
        out.notes.push('Schedule enabled; timing is not exposed by the point, so the expected valve state cannot be checked.')
        return out
    }

    const logic = { parseHHMM, fmtHHMM, parseWindowValue, formatWindowValue, isOvernight, inWindow, nextEvent, describeEvent,
                    classifyBool, interpretSchedule, deriveUvStatus, deriveIrrigationStatus, valveState }
    if (typeof module !== 'undefined' && module.exports) module.exports = logic
    if (typeof document === 'undefined') return

    // ───────────────────────────────── UI ─────────────────────────────────

    const api = root
    const cards = { uv: {}, irr: {} }
    let refreshing = false
    let lastRefresh = null

    function el(tag, cls, text) {
        const e = document.createElement(tag)
        if (cls) e.className = cls
        if (text !== undefined) e.textContent = text
        return e
    }

    function row(label) {
        const r = el('div', 'sch-row')
        r.appendChild(el('span', 'sch-k', label))
        const v = el('span', 'sch-v', '—')
        r.appendChild(v)
        return { r, v }
    }

    function buildCard(kind, n) {
        const isUv = kind === 'uv'
        const c = { kind, n, schedName: isUv ? `LIGHT1_sch (UNIT${n} light)` : 'ValveSch_' + n, valveName: isUv ? null : 'VALVE_' + n, busy: false, state: null }
        c.root = el('div', 'sch-card')
        const head = el('div', 'sch-head')
        head.appendChild(el('span', 'sch-unit', 'Unit ' + n))
        c.badge = el('span', 'sch-badge s-unconfirmed', 'Reading…')
        head.appendChild(c.badge)
        c.root.appendChild(head)

        const rows = el('div', 'sch-rows')
        if (isUv) {
            // Confirmed on-site: no separate schedule/window point exists for UV — just
            // one on/off point per unit. No Window/Next-event rows to show for it.
            c.rLight = row('Light state'); rows.appendChild(c.rLight.r)
        } else {
            c.rSched = row('Schedule')
            c.rWindow = row('Window')
            rows.appendChild(c.rSched.r); rows.appendChild(c.rWindow.r)
            c.rValve = row('Actual valve'); rows.appendChild(c.rValve.r)
            c.rNext = row('Next event'); rows.appendChild(c.rNext.r)
        }
        c.root.appendChild(rows)

        c.alert = el('div', 'sch-alert'); c.alert.hidden = true
        c.root.appendChild(c.alert)

        c.raw = el('div', 'sch-raw', c.schedName + ' = …')
        c.root.appendChild(c.raw)

        const ctl = el('div', 'sch-ctl')
        c.toggleBtn = el('button', 'sch-btn', isUv ? 'Turn on / off' : 'Enable / Disable')
        c.toggleBtn.type = 'button'
        c.toggleBtn.addEventListener('click', () => onToggle(c))
        ctl.appendChild(c.toggleBtn)

        if (!isUv) {
            c.times = el('div', 'sch-times')
            c.startIn = el('input'); c.startIn.type = 'time'; c.startIn.setAttribute('aria-label', 'Unit ' + n + ' start time')
            c.stopIn  = el('input'); c.stopIn.type = 'time';  c.stopIn.setAttribute('aria-label', 'Unit ' + n + ' stop time')
            ;[c.startIn, c.stopIn].forEach(i => i.addEventListener('input', () => { i.dataset.dirty = '1' }))
            c.applyBtn = el('button', 'sch-btn', 'Apply times'); c.applyBtn.type = 'button'
            c.applyBtn.addEventListener('click', () => onApplyTimes(c))
            c.times.appendChild(el('label', 'sch-lbl', 'Start')); c.times.appendChild(c.startIn)
            c.times.appendChild(el('label', 'sch-lbl', 'Stop'));  c.times.appendChild(c.stopIn)
            c.times.appendChild(c.applyBtn)
            ctl.appendChild(c.times)
        }
        c.root.appendChild(ctl)

        c.msg = el('div', 'sch-msg'); c.msg.hidden = true
        c.root.appendChild(c.msg)
        return c
    }

    function setMsg(c, text, cls) {
        c.msg.hidden = !text
        c.msg.textContent = text || ''
        c.msg.className = 'sch-msg ' + (cls || '')
    }

    function renderUv(c) {
        const d = deriveUvStatus(c.state.sched)
        c.badge.textContent = d.label
        c.badge.className = 'sch-badge s-' + d.status

        c.rLight.v.textContent = d.status === 'running' ? 'ON' : d.status === 'off' ? 'OFF' : d.status === 'error' ? 'Unavailable' : 'Unrecognised'
        c.rLight.v.className = 'sch-v ' + (d.status === 'running' ? 'v-open' : d.status === 'off' ? 'v-closed' : d.status === 'error' ? 'v-error' : 'v-unknown')

        const alerts = []
        if (d.error) alerts.push(d.error)
        d.notes.forEach(n => alerts.push(n))
        c.alert.hidden = alerts.length === 0
        c.alert.textContent = alerts.join(' ')
        c.alert.className = 'sch-alert ' + (d.error ? 'err' : 'note')

        const sr = c.state.sched
        c.raw.textContent = sr && sr.ok ? `${c.schedName} = ${JSON.stringify(sr.value)} (${typeof sr.value})` : `${c.schedName}: unavailable`

        const canToggle = d.status === 'running' || d.status === 'off'
        c.toggleBtn.disabled = !canToggle || c.busy
        c.toggleBtn.textContent = d.status === 'running' ? 'Turn OFF' : d.status === 'off' ? 'Turn ON' : 'Turn on / off'
    }

    function renderIrr(c) {
        const now = new Date()
        const d = deriveIrrigationStatus(c.state.sched, c.state.valve, now)
        const s = d.schedule

        c.badge.textContent = d.label
        c.badge.className = 'sch-badge s-' + d.status

        let sched = '—'
        if (s.kind === 'bool') sched = s.enabled ? 'Enabled' : 'Disabled'
        else if (s.kind === 'window') sched = 'Enabled (window set)'
        else if (s.kind === 'unknown') sched = 'Value format unconfirmed'
        else sched = 'Unavailable'
        c.rSched.v.textContent = sched

        if (s.kind === 'window') {
            const over = isOvernight(s.startMin, s.stopMin)
            c.rWindow.v.textContent = `${fmtHHMM(s.startMin)} → ${fmtHHMM(s.stopMin)}${over ? ' (+1 day)' : ''}`
        } else {
            c.rWindow.v.textContent = s.kind === 'error' ? 'Unavailable' : 'Not exposed by this point'
        }

        const v = d.valve
        const rv = c.state.valve
        c.rValve.v.textContent = v.state === 'open' ? 'OPEN' : v.state === 'closed' ? 'CLOSED' : v.state === 'unknown' ? 'Unrecognised' : 'Unavailable'
        c.rValve.v.className = 'sch-v v-' + v.state
        c.rValve.v.title = rv && rv.ok ? `${c.valveName} = ${JSON.stringify(rv.value)}` : (rv && rv.error) || ''

        c.rNext.v.textContent = d.next ? describeEvent(d.next, now) : '—'

        const alerts = []
        if (d.error) alerts.push(d.error)
        if (d.discrepancy) alerts.push('Discrepancy: ' + d.discrepancy)
        d.notes.forEach(n => alerts.push(n))
        c.alert.hidden = alerts.length === 0
        c.alert.textContent = alerts.join(' ')
        c.alert.className = 'sch-alert ' + (d.error ? 'err' : d.discrepancy ? 'warn' : 'note')

        const sr = c.state.sched
        c.raw.textContent = sr && sr.ok ? `${c.schedName} = ${JSON.stringify(sr.value)} (${typeof sr.value})` : `${c.schedName}: unavailable`

        const canToggle = s.kind === 'bool' && !c.busy
        const canTimes  = s.kind === 'window' && !c.busy
        c.toggleBtn.hidden = s.kind !== 'bool'
        c.toggleBtn.disabled = !canToggle
        c.toggleBtn.textContent = s.kind === 'bool' ? (s.enabled ? 'Disable schedule' : 'Enable schedule') : ''
        c.times.hidden = s.kind !== 'window'
        c.applyBtn.disabled = !canTimes
        if (s.kind === 'window') {
            if (!c.startIn.dataset.dirty && document.activeElement !== c.startIn) c.startIn.value = fmtHHMM(s.startMin)
            if (!c.stopIn.dataset.dirty && document.activeElement !== c.stopIn)   c.stopIn.value  = fmtHHMM(s.stopMin)
        }
        if (s.kind === 'unknown') setMsg(c, 'Writes disabled: the value format in ' + c.schedName + ' is not recognised, so nothing will be written blindly.', 'warn')
        else if (s.kind === 'bool' && !c.msg.textContent) setMsg(c, 'Start/stop times are not exposed by ' + c.schedName + ' (boolean point). Supply the time point/format to enable them.', 'note')
    }

    function render(c) { c.kind === 'uv' ? renderUv(c) : renderIrr(c) }

    async function refreshCard(c) {
        if (c.kind === 'uv') {
            c.state = { sched: await api.readUvLightPoint(c.n) }
        } else {
            const [sched, valve] = await Promise.all([api.readSchedulePoint(c.schedName), api.readSchedulePoint(c.valveName)])
            c.state = { sched, valve }
        }
        render(c)
    }

    async function pool(items, limit, fn) {
        const q = items.slice()
        await Promise.all(Array.from({ length: Math.min(limit, q.length) }, async () => { while (q.length) await fn(q.shift()) }))
    }

    async function refreshAll() {
        if (refreshing) return
        // Skip this poll while a manual write (e.g. the CO2 override toggle) is settling.
        // Added 2026-10-01: control.html already paused its own refresh during this
        // window, but this scheduler poll never did — so its ~20-point burst (UV +
        // irrigation, every 10s) could still pile into the shared request queue right
        // when an operator is waiting on a toggle, making it feel much slower than the
        // ~3s the toggle itself actually needs. This closes that gap; it doesn't touch
        // the queue, the settle delay, or anything else.
        if (typeof api.isWriteSettling === 'function' && api.isWriteSettling()) return
        refreshing = true
        try {
            const all = [...Object.values(cards.uv), ...Object.values(cards.irr)].filter(c => !c.busy)
            await pool(all, 4, c => refreshCard(c).catch(err => { c.state = { sched: { ok: false, error: String(err && err.message || err) } }; render(c) }))
            lastRefresh = new Date()
            document.querySelectorAll('.sch-updated').forEach(e => { e.textContent = 'JACE read ' + lastRefresh.toLocaleTimeString('en-ZA', { hour12: false }) })
        } finally { refreshing = false }
    }

    async function doWrite(c, value) {
        c.busy = true; render(c)
        setMsg(c, 'Writing ' + c.schedName + '…', 'note')
        const old = c.state && c.state.sched && c.state.sched.ok ? c.state.sched.value : null
        let res
        try {
            res = c.kind === 'uv'
                ? await api.writeUvLightPoint(c.n, value, old)
                : await api.writeSchedulePoint(c.schedName, value, old, 'Greenhouse ' + c.n)
        } catch (err) { res = { ok: false, error: String(err && err.message || err) } }
        // always re-read from the JACE and render what it says
        await refreshCard(c).catch(() => {})
        c.busy = false
        if (!res.ok) setMsg(c, res.error, 'err')
        else if (res.verified) setMsg(c, `Written and confirmed by JACE read-back: ${JSON.stringify(res.readBack)}`, 'ok')
        else setMsg(c, res.error, 'warn')
        render(c)
        return res
    }

    async function onToggle(c) {
        if (c.kind === 'uv') {
            const b = classifyBool(c.state && c.state.sched && c.state.sched.ok ? c.state.sched.value : null)
            if (b === null) return
            const next = !b
            if (!confirm(`Turn UV light ${next ? 'ON' : 'OFF'} for Unit ${c.n}? This writes the JACE light point directly — it is not a schedule.`)) return
            await doWrite(c, next)
            return
        }
        const s = interpretSchedule(c.state && c.state.sched)
        if (s.kind !== 'bool') return
        const next = !s.enabled
        if (!confirm(`${next ? 'Enable' : 'Disable'} irrigation schedule for Unit ${c.n}? This writes ${c.schedName} on the JACE.`)) return
        await doWrite(c, next)
    }

    async function onApplyTimes(c) {
        const s = interpretSchedule(c.state && c.state.sched)
        if (s.kind !== 'window') return
        const a = parseHHMM(c.startIn.value), b = parseHHMM(c.stopIn.value)
        if (a === null || b === null) { setMsg(c, 'Enter both a start and a stop time.', 'err'); return }
        if (a === b) { setMsg(c, 'Start and stop times cannot be identical.', 'err'); return }
        const value = formatWindowValue(a, b, s.sep)
        const over = isOvernight(a, b) ? ' (overnight: runs into the next day)' : ''
        if (!confirm(`Set Unit ${c.n} ${c.kind === 'uv' ? 'UV' : 'irrigation'} window to ${fmtHHMM(a)} → ${fmtHHMM(b)}${over}? This writes ${c.schedName} = "${value}".`)) return
        const res = await doWrite(c, value)
        if (res.ok) { delete c.startIn.dataset.dirty; delete c.stopIn.dataset.dirty; render(c) }
    }

    function buildSection(host, kind, title, sub) {
        host.innerHTML = ''
        const head = el('div', 'sch-section-head')
        const t = el('div', 'sch-section-title', title)
        t.appendChild(el('span', 'sch-section-sub', sub))
        head.appendChild(t)
        const right = el('div', 'sch-section-right')
        right.appendChild(el('span', 'sch-updated', 'Reading JACE…'))
        const btn = el('button', 'sch-btn sch-refresh', 'Refresh now'); btn.type = 'button'
        btn.addEventListener('click', () => { kind === 'irr' ? api.discoverSchedulePoints(true).finally(refreshAll) : refreshAll() })
        right.appendChild(btn)
        head.appendChild(right)
        host.appendChild(head)
        const grid = el('div', 'sch-grid')
        const selected = (localStorage.getItem('selectedUnit') || '').replace('UNIT', '')
        for (let n = 1; n <= UNITS; n++) {
            const c = buildCard(kind, n)
            if (String(n) === selected) c.root.classList.add('sch-selected')
            cards[kind][n] = c
            grid.appendChild(c.root)
        }
        host.appendChild(grid)
    }

    function init() {
        const uvHost = document.getElementById('uvSchedulerSection')
        const irHost = document.getElementById('irrigationSchedulerSection')
        if (!uvHost || !irHost) return
        if (typeof api.readSchedulePoint !== 'function' || typeof api.readUvLightPoint !== 'function') {
            uvHost.textContent = irHost.textContent = 'api.js scheduler layer not loaded.'
            return
        }
        buildSection(uvHost, 'uv', 'UV Lighting', 'Single on/off point per unit (confirmed on-site) · same point as Manual ON/OFF above · no schedule/window exists on the JACE')
        buildSection(irHost, 'irr', 'Irrigation', 'ValveSch_1–10 / VALVE_1–10: under raw slot names "Irrigation_Valves$201$2d8" / "Irrigation_Valves$209$2d10" — confirmed on-site 2026-09-30 from Aina\'s Workbench ORD copy')
        refreshAll()
        setInterval(refreshAll, POLL_MS)
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
    else init()
})(typeof window !== 'undefined' ? window : globalThis)