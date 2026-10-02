/**
 * ARC Glasshouse System - Live Telemetry Core
 * Official One Sight Solutions ossRestApiServer OAuth2 Integration
 * Fixed: credentials, write priority, mock substitution logging, write-settle guard
 */

// 1. CORE CONFIGURATION
const USE_LIVE_API = true  // ← already flipped for on-site use

const OSS_BASE_URL = 'https://192.168.1.140/ossRestApiServer'
const OSS_TOKEN_URL = `${OSS_BASE_URL}/token`

// ✅ CORRECT credentials from Aina's Niagara screen
const OSS_CLIENT_ID     = 'QfHrBgQpbnIJzLNASJiBINnUmwbEhOfL'
const OSS_CLIENT_SECRET = 'g:6x,w3a.0cqQn7+mRR%W2.XJ7UjgtNa,KjD;sbQ2P5D_-W5tGWwNWKKJkSQv5esQ;7pWp9CDe.SBpT+5xZjftTVMh~;Qkwd;UTb;jDW&g1i8;45hy&:kpaSr-v:Cnr+.Moyg6f8&#fTtgH2%.8n@EzuIxTZeb-IUGd.1xKWEL+_Vgg2y%#4edTNT:YZI-i+GfeFe5O;MyR;yrwE3@gSN$qz5uKrwThKEJ2&75uaRaOj7H;Vp2IV@_.L2M&SrGpr'

const CONNECTION_TIMEOUT      = 3000
const API_TIMEOUT             = 5000
const WRITE_PRIORITY          = 1    // Raised app-wide 2026-10-01, on-site, by user decision. History:
                                      // 2026-09-30 testing (7/16/8/1) found no physical response at
                                      // any priority, but that was before the Schedule-point and
                                      // settle-delay bugs were found and fixed — it wasn't a clean
                                      // test of priority alone. Today, with those fixed, writes at 16
                                      // (and 8) were confirmed on-site to be accepted (HTTP 200) but
                                      // never actually take effect — not just for CO2, but for UV
                                      // lighting and irrigation too (same "accepted but unchanged"
                                      // read-back on LIGHT1_sch and ValveSch_2). A direct priority-1
                                      // probe made BOTH CO2_MACOST and LIGHT1_sch stick immediately,
                                      // confirming something else (likely Aina's interface) holds a
                                      // higher priority than 16 across multiple point types, not just
                                      // CO2. Decision: raise the app-wide default to 1 (highest BACnet
                                      // priority) so this app's writes always win, rather than testing
                                      // every point type individually. Known tradeoff, accepted
                                      // on-site: this app now out-ranks any other system writing to
                                      // these points, including Aina's interface. Revert to 16 if this
                                      // causes new problems — it's one constant.
const TOKEN_STORAGE_KEY       = 'arc_oss_access_token'
const TOKEN_EXPIRY_STORAGE_KEY= 'arc_oss_token_expiry'
const CONNECTION_CACHE_DURATION = 30000

// Write-settle guard — suppresses refresh for 3s after a write
// so Niagara has time to apply the value before we read it back
let _lastWriteTime = 0
const WRITE_SETTLE_MS = 6000  // was 3000 — control.html polls every 5000ms, so a 3s guard left a
                               // ~2s gap where an auto-refresh could read a stale value before the
                               // JACE caught up, making a fresh write look like it "reverted on its
                               // own." 6000ms comfortably outlasts one full poll cycle.

// 2. TOKEN CACHE AND REQUEST HELPERS
let _accessToken = null
let _tokenExpiry = 0
let _tokenPromise = null
let _ossReachable = null
let _lastConnectionCheck = 0

function hasWindow()          { return typeof window !== 'undefined' }
function hasStorage()         { return typeof localStorage !== 'undefined' }
function hasSessionStorage()  { return typeof sessionStorage !== 'undefined' }

function base64Encode(value) {
    if (typeof btoa === 'function') return btoa(value)
    if (typeof Buffer !== 'undefined') return Buffer.from(value, 'utf8').toString('base64')
    throw new Error('No Base64 encoder available in this runtime.')
}

function buildBasicAuthHeader(clientId, clientSecret) {
    return `Basic ${base64Encode(`${clientId}:${clientSecret}`)}`
}

function normalizeBaseUrl(url) {
    return String(url || '').replace(/\/+$/, '')
}

function encodeSlotPath(slotPath) {
    return String(slotPath || '')
        .replace(/^\/+/, '')
        .split('/')
        .filter(Boolean)
        .map(segment => encodeURIComponent(segment))
        .join('/')
}

function getMockValue(unit, point) {
    return MOCK_DATA?.[unit]?.[point] ?? null
}

function isAbortError(err) {
    return err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')
}

// ── LIVE-READ PROVENANCE TRACKING ── added 2026-10-01
// readPoint() has always fallen back to mock data on any read failure (no slot path,
// non-OK HTTP, timeout/exception) so a bad read never crashes the app — but that
// fallback was silent and visually indistinguishable from a real live reading. Result:
// after a page load or a poll where even one read failed, override toggles rendered a
// confident ON or OFF straight from stale mock data while the physical unit was in the
// opposite state ("toggles on but units everything is off"). This tracks, per
// unit/point, whether the MOST RECENT read was a genuine live value or a mock
// substitution, so the UI can show "unconfirmed" instead of a wrong-but-confident state.
const _pointLiveness = {}
function _liveKey(unit, point) { return `${unit}|${point}` }
function _markLiveness(unit, point, live) { _pointLiveness[_liveKey(unit, point)] = live }
// Defaults to true (optimistic) for a point that has never been read yet, so the UI
// doesn't flash "unconfirmed" before the first read of a session completes.
function isPointLive(unit, point) {
    const v = _pointLiveness[_liveKey(unit, point)]
    return v === undefined ? true : v
}

async function readResponseBody(res) {
    const text = await res.text()
    if (!text) return null
    try { return JSON.parse(text) } catch { return text }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = API_TIMEOUT) {
    if (typeof fetch !== 'function') throw new Error('Fetch API is not available.')
    const controller = new AbortController()
    const timeoutId  = setTimeout(() => controller.abort(), timeoutMs)
    try {
        return await fetch(url, { ...options, signal: controller.signal })
    } finally {
        clearTimeout(timeoutId)
    }
}

function loadCachedToken() {
    if (_accessToken && Date.now() < _tokenExpiry) return _accessToken
    if (!hasSessionStorage()) return null
    try {
        const token  = sessionStorage.getItem(TOKEN_STORAGE_KEY)
        const expiry = Number(sessionStorage.getItem(TOKEN_EXPIRY_STORAGE_KEY) || 0)
        if (token && Date.now() < expiry) { _accessToken = token; _tokenExpiry = expiry; return token }
    } catch (err) { console.warn('[ARC] Token cache read failed:', err) }
    return null
}

function saveCachedToken(token, expiresInSeconds) {
    const safeExpiryMs = Math.max(0, Number(expiresInSeconds || 0) * 1000 - 30000)
    const expiry = Date.now() + safeExpiryMs
    _accessToken = token
    _tokenExpiry = expiry
    if (!hasSessionStorage()) return
    try {
        sessionStorage.setItem(TOKEN_STORAGE_KEY, token)
        sessionStorage.setItem(TOKEN_EXPIRY_STORAGE_KEY, String(expiry))
    } catch (err) { console.warn('[ARC] Token cache write failed:', err) }
}

function clearCachedToken() {
    _accessToken = null; _tokenExpiry = 0; _tokenPromise = null
    if (!hasSessionStorage()) return
    try { sessionStorage.removeItem(TOKEN_STORAGE_KEY); sessionStorage.removeItem(TOKEN_EXPIRY_STORAGE_KEY) } catch {}
}

async function getToken() {
    const cached = loadCachedToken()
    if (cached) return cached
    if (_tokenPromise) return _tokenPromise

    _tokenPromise = (async () => {
        try {
            console.log('[ARC] Requesting ossRestApiServer access token...')
            const body = new URLSearchParams()
            body.set('grant_type', 'client_credentials')
            body.set('scope', 'read write')

            const res = await fetchWithTimeout(OSS_TOKEN_URL, {
                method: 'POST',
                headers: {
                    Authorization: buildBasicAuthHeader(OSS_CLIENT_ID, OSS_CLIENT_SECRET),
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Accept: 'application/json'
                },
                body: body.toString()
            }, CONNECTION_TIMEOUT)

            const data = await readResponseBody(res)
            if (!res.ok) { clearCachedToken(); console.error(`[ARC] Token rejected: HTTP ${res.status}`, data || ''); return null }
            if (!data || !data.access_token) { clearCachedToken(); console.error('[ARC] Token response missing access_token', data || ''); return null }

            saveCachedToken(data.access_token, data.expires_in || 3600)
            console.log('[ARC] ✅ Access token obtained.')
            return data.access_token
        } catch (err) {
            clearCachedToken()
            console.error('[ARC] Authentication failed:', isAbortError(err) ? 'timeout' : err.message)
            return null
        } finally {
            _tokenPromise = null
        }
    })()

    return _tokenPromise
}

// ── 401-RECOVERY LOCK ──
// Diagnosed on-site 2026-10-01: "Token is obtained" then every read 401s with
// "No matching authorisation token was found," even on points that just worked, with
// a visible retry loop (repeated "Requesting ossRestApiServer access token..."). Root
// cause: readMultiplePoints fires ~20 reads in parallel, plus the scheduler poller runs
// alongside the dashboard poller — so when ONE shared token goes bad, many requests hit
// 401 in the same tick. The OLD retry path had every single one of them independently
// call clearCachedToken() (which unconditionally nulls _tokenPromise) and then
// getToken() again. That let a second 401 handler wipe out the _tokenPromise a sibling
// 401 handler had just started waiting on, so multiple concurrent POSTs to /token fired
// for the same client in the same burst. Niagara then handed out several tokens in
// quick succession; by the time an earlier one was used for a retry, a later grant had
// already superseded it, so the JACE reported "No matching authorisation token was
// found" — not because auth was wrong, but because the token in hand was already stale
// by the time it was used. This was a genuine race, not a credentials/scope problem.
//
// Fix: serialize re-auth behind a single promise so a whole burst of simultaneous 401s
// triggers exactly ONE token refresh, and every caller in that burst awaits and reuses
// that same result instead of racing its own. Nothing about credentials, write
// priority, or the CO2 sequence changes.
let _reauthPromise = null
async function reauthenticateAfter401() {
    if (_reauthPromise) return _reauthPromise
    _reauthPromise = (async () => {
        // Clear only the stored token value here — never _tokenPromise — so this can't
        // cancel a getToken() call a sibling 401 handler may already be awaiting.
        _accessToken = null; _tokenExpiry = 0
        if (hasSessionStorage()) {
            try { sessionStorage.removeItem(TOKEN_STORAGE_KEY); sessionStorage.removeItem(TOKEN_EXPIRY_STORAGE_KEY) } catch {}
        }
        return await getToken()
    })()
    try {
        return await _reauthPromise
    } finally {
        _reauthPromise = null
    }
}

// ── GLOBAL REQUEST QUEUE ──
// Diagnosed on-site 2026-10-01, round 2: the 401-reauth race above was real and is
// still correct, but after fixing it, reads STILL 401 — now clearly one-at-a-time
// (VALVE_10 401s, a single fresh token is fetched, then the very next read —
// ValveSch_10 — 401s again too), not a flood any more. The common factor left:
// scheduler.js's refreshCard() reads its Schedule + Valve point with Promise.all (2 at
// once), and its pool() runs up to 4 cards at once — so up to 8 requests can reach the
// JACE at genuinely the same moment, on top of control.html's own 5s poll running on an
// independent timer. This Niagara OSS REST bridge appears unable to tolerate two
// in-flight requests sharing one Bearer token: a second request landing while a first
// is still being processed seems to invalidate the token for the first, which is
// consistent with "No matching authorisation token was found" showing up even right
// after a token was confirmed good. Fix: force every request to the JACE through a
// single FIFO queue so only one is ever in flight at a time, whatever fired it
// (dashboard poll, scheduler poll, a manual toggle). This only changes timing — no
// path, credential, or priority changes, and it cannot make a previously-working read
// fail, only make a racing one wait its turn.
let _requestQueue = Promise.resolve()
function enqueueJaceRequest(task) {
    const run = _requestQueue.then(task, task)
    _requestQueue = run.then(() => {}, () => {}) // one failure must not jam the queue
    return run
}

async function authedRequest(url, options = {}, timeoutMs = API_TIMEOUT, retryOnUnauthorized = true) {
    return enqueueJaceRequest(() => authedRequestNow(url, options, timeoutMs, retryOnUnauthorized))
}

// Confirmed on-site 2026-10-01: Aina's own tooling authenticates against this SAME
// ossRestApiServer client. A single reauth-and-retry only has so-so odds of landing in
// a window where our freshly-issued token is still the one the JACE honors, because his
// tool can mint its own token at any moment and (on this kind of lightweight embedded
// OAuth issuer) that silently invalidates whatever token we're holding, regardless of
// its stated expiry — that's why a token confirmed good one moment was rejected on the
// very next request last time. We can't coordinate with his tool from here, so instead
// we give our own side more chances to win that race: retry a few times with a short
// randomized gap, instead of giving up after one retry.
const AUTH_RACE_MAX_ATTEMPTS = 4          // original attempt + up to 3 reauth retries
const AUTH_RACE_RETRY_BASE_MS = 150       // backoff grows a little each attempt, plus jitter

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function authedRequestNow(url, options, timeoutMs, retryOnUnauthorized) {
    const token = await getToken()
    if (!token) throw new Error('Authentication token unavailable.')

    let res = await fetchWithTimeout(url, {
        ...options,
        headers: { Accept: 'application/json', ...(options.headers || {}), Authorization: `Bearer ${token}` }
    }, timeoutMs)

    if (!retryOnUnauthorized) return res

    for (let attempt = 1; res.status === 401 && attempt < AUTH_RACE_MAX_ATTEMPTS; attempt++) {
        await sleep(AUTH_RACE_RETRY_BASE_MS * attempt + Math.random() * 150)
        const freshToken = await reauthenticateAfter401()
        if (!freshToken) throw new Error('Token refresh failed.')
        res = await fetchWithTimeout(url, {
            ...options,
            headers: { Accept: 'application/json', ...(options.headers || {}), Authorization: `Bearer ${freshToken}` }
        }, timeoutMs)
    }

    return res
}

// 3. SLOT PATH DISCOVERY AND MAPPING
// 3. COMPLETE SLOT PATH MAP
// All paths verified via listPoints() on-site
// $2e = dot, $20 = space (Niagara encoding)
const SLOT_PATHS = {
    // ── STANDARD POINTS (per unit) ──
    SPACE_TEMP:        unit => `Drivers/BacnetNetwork/${unit}/points/SPACE_TEMP`,
    RELATIVE_HUMIDITY: unit => `Drivers/BacnetNetwork/${unit}/points/RELATIVE_HUMIDITY`,
    CO2:               unit => `Drivers/BacnetNetwork/${unit}/points/C02`,
    UNIT_STATUS:       unit => `Drivers/BacnetNetwork/${unit}/points/UNIT_STATUS`,
    UNIT_MODE:         unit => `Drivers/BacnetNetwork/${unit}/points/UNIT_MODE`,
    UNIT_ENABLE:       unit => `Drivers/BacnetNetwork/${unit}/points/UNIT_ENABLE`,
    TEMP_SETPOINT:     unit => `Drivers/BacnetNetwork/${unit}/points/TEMP_SETPOINT`,
    HUMIDITY_SETPOINT: unit => `Drivers/BacnetNetwork/${unit}/points/HUMIDITY_SETPOINT`,
    CO2_SETPOINT:      unit => `Drivers/BacnetNetwork/${unit}/points/C02_SETPOINT`,
    HUMIDITY_DEMAND:   unit => `Drivers/BacnetNetwork/${unit}/points/HUMIDITY_DEMAND`,
    CO2_DEMAND:        unit => `Drivers/BacnetNetwork/${unit}/points/C02_DEMAND`,
    FAN_SCH:           unit => `Drivers/BacnetNetwork/${unit}/points/FAN$2esch`,
    // ── UNIT9 has HUMD$2eHUMDSCH (extra D), all others use HUMD$2eHUMSCH ──
    HUMID_Sched:       unit => unit === 'UNIT9'
                            ? `Drivers/BacnetNetwork/${unit}/points/HUMD$2eHUMDSCH`
                            : `Drivers/BacnetNetwork/${unit}/points/HUMD$2eHUMSCH`,
    CO2_Sched:         unit => `Drivers/BacnetNetwork/${unit}/points/CO2$2eC02SCH`,
    CO2_MACOST:        unit => `Drivers/BacnetNetwork/${unit}/points/CO2$2eMACOST`,
    CO2_MACOV:         unit => `Drivers/BacnetNetwork/${unit}/points/CO2$2eMACOV`,
    HUMID_MAHOST:      unit => `Drivers/BacnetNetwork/${unit}/points/HUMD$2eMAHOST`,
    HUMID_MAHOV:       unit => `Drivers/BacnetNetwork/${unit}/points/HUMD$2eMAHOV`,
    // ── EXTRA POINTS (UNIT7, 8, 9 confirmed, may exist on others) ──
    AIR_FLOW:          unit => `Drivers/BacnetNetwork/${unit}/points/AIR_FLOW`,
    DOOR:              unit => `Drivers/BacnetNetwork/${unit}/points/DOOR`,
    // ── UV LIGHTS (separate lighting network) ──
    // Confirmed on-site 2026-09-28 via listPoints: UNIT1..UNIT8 are named "<unit>_LIGHT",
    // but UNIT9 and UNIT10 have NO "_LIGHT" suffix on this JACE (naming is inconsistent
    // at the source). Without this fix, units 9 & 10 would silently mock-fallback.
    LIGHT1_sch:        unit => `Drivers/BacnetNetwork/LIGHTING$20SYSTEM/points/${(unit === 'UNIT9' || unit === 'UNIT10') ? unit : unit + '_LIGHT'}`,
    LIGHT1_Manual:     unit => `Drivers/BacnetNetwork/LIGHTING$20SYSTEM/points/${(unit === 'UNIT9' || unit === 'UNIT10') ? unit : unit + '_LIGHT'}`,
}

function resolveSlotPath(unit, point) {
    const resolver = SLOT_PATHS[point]
    if (resolver) return resolver(unit)
    console.warn(`[ARC] ⚠️ No slot path defined for point: ${point}`)
    return null
}

function getSlotPath(unit, point) { return resolveSlotPath(unit, point) }

// Legacy localStorage slot path map — kept for backward compatibility
function getSlotPathMap() { try { return JSON.parse(localStorage.getItem(SLOT_PATH_MAP_KEY) || '{}') } catch { return {} } }
function saveSlotPathMap(map) { try { localStorage.setItem(SLOT_PATH_MAP_KEY, JSON.stringify(map || {})); return true } catch { return false } }
function setSlotPath(unit, point, slotPath) {
    const map = getSlotPathMap()
    if (!map[unit]) map[unit] = {}
    map[unit][point] = String(slotPath)
    return saveSlotPathMap(map)
}

async function listPoints() {
    if (!USE_LIVE_API) { console.log('[ARC] listPoints skipped — mock mode active.'); return [] }
    try {
        const url = `${normalizeBaseUrl(OSS_BASE_URL)}/query/listPoints`
        const res = await authedRequest(url, { method: 'GET' }, API_TIMEOUT)
        const data = await readResponseBody(res)
        if (!res.ok) { console.warn(`[ARC] listPoints failed: HTTP ${res.status}`, data || ''); return [] }
        console.log('[ARC] 📋 Available points:', data)
        return data || []
    } catch (err) { console.warn('[ARC] listPoints failed:', isAbortError(err) ? 'timeout' : err.message); return [] }
}

// 4. CONNECTION HEALTH
async function isN4Reachable() {
    if (!USE_LIVE_API) return false
    const now = Date.now()
    if (_ossReachable !== null && now - _lastConnectionCheck < CONNECTION_CACHE_DURATION) return _ossReachable
    try { const token = await getToken(); _ossReachable = !!token } catch { _ossReachable = false }
    _lastConnectionCheck = Date.now()
    console.log(`[ARC] Station: ${_ossReachable ? '✅ ONLINE' : '❌ OFFLINE'}`)
    return _ossReachable
}

// 5. LIVE GREENHOUSE TELEMETRY
async function fetchLiveGreenhouseTelemetry() {
    if (!MOCK_DATA) initState()
    if (!USE_LIVE_API) return getMockData()
    const reachable = await isN4Reachable()
    if (!reachable) { console.warn('[ARC] ⚠️ MOCK SUBSTITUTION (unreachable): entire telemetry'); return getMockData() }
    const telemetry = {}
    for (const unit of Object.keys(MOCK_DATA)) {
        telemetry[unit] = {}
        for (const point of Object.keys(MOCK_DATA[unit])) {
            telemetry[unit][point] = await readPoint(unit, point)
        }
    }
    return telemetry
}

// 6. PERSISTENT STATE
const STATE_KEY = 'arc_unit_state'

const DEFAULT_MOCK_DATA = {
    UNIT1:  { SPACE_TEMP: 22.4, RELATIVE_HUMIDITY: 65,  CO2: 412, UNIT_STATUS: 'Active',   UNIT_MODE: 'Heating', UNIT_ENABLE: true,  TEMP_SETPOINT: 22, HUMIDITY_SETPOINT: 60, CO2_SETPOINT: 400, HUMIDITY_DEMAND: false, CO2_DEMAND: false, FAN_SCH: true,  HUMID_Sched: false, CO2_Sched: false, CO2_MACOST: false, CO2_MACOV: 800, HUMID_MAHOST: false, HUMID_MAHOV: 60, LIGHT1_sch: true,  LIGHT1_Manual: false },
    UNIT2:  { SPACE_TEMP: 24.1, RELATIVE_HUMIDITY: 70,  CO2: 398, UNIT_STATUS: 'Active',   UNIT_MODE: 'Cooling', UNIT_ENABLE: true,  TEMP_SETPOINT: 24, HUMIDITY_SETPOINT: 65, CO2_SETPOINT: 400, HUMIDITY_DEMAND: true,  CO2_DEMAND: false, FAN_SCH: true,  HUMID_Sched: true,  CO2_Sched: false, CO2_MACOST: false, CO2_MACOV: 800, HUMID_MAHOST: false, HUMID_MAHOV: 65, LIGHT1_sch: true,  LIGHT1_Manual: false },
    UNIT3:  { SPACE_TEMP: 21.8, RELATIVE_HUMIDITY: 58,  CO2: 420, UNIT_STATUS: 'Active',   UNIT_MODE: 'Heating', UNIT_ENABLE: true,  TEMP_SETPOINT: 22, HUMIDITY_SETPOINT: 60, CO2_SETPOINT: 400, HUMIDITY_DEMAND: false, CO2_DEMAND: false, FAN_SCH: true,  HUMID_Sched: false, CO2_Sched: false, CO2_MACOST: false, CO2_MACOV: 800, HUMID_MAHOST: false, HUMID_MAHOV: 60, LIGHT1_sch: false, LIGHT1_Manual: false },
    UNIT4:  { SPACE_TEMP: 23.0, RELATIVE_HUMIDITY: 62,  CO2: 405, UNIT_STATUS: 'Active',   UNIT_MODE: 'Cooling', UNIT_ENABLE: true,  TEMP_SETPOINT: 23, HUMIDITY_SETPOINT: 62, CO2_SETPOINT: 400, HUMIDITY_DEMAND: false, CO2_DEMAND: false, FAN_SCH: true,  HUMID_Sched: false, CO2_Sched: false, CO2_MACOST: false, CO2_MACOV: 800, HUMID_MAHOST: false, HUMID_MAHOV: 62, LIGHT1_sch: true,  LIGHT1_Manual: false },
    UNIT5:  { SPACE_TEMP: 19.5, RELATIVE_HUMIDITY: 55,  CO2: 415, UNIT_STATUS: 'Active',   UNIT_MODE: 'Standby', UNIT_ENABLE: true,  TEMP_SETPOINT: 20, HUMIDITY_SETPOINT: 55, CO2_SETPOINT: 400, HUMIDITY_DEMAND: false, CO2_DEMAND: false, FAN_SCH: false, HUMID_Sched: false, CO2_Sched: false, CO2_MACOST: false, CO2_MACOV: 800, HUMID_MAHOST: false, HUMID_MAHOV: 55, LIGHT1_sch: false, LIGHT1_Manual: false },
    UNIT6:  { SPACE_TEMP: 25.2, RELATIVE_HUMIDITY: 72,  CO2: 390, UNIT_STATUS: 'Active',   UNIT_MODE: 'Cooling', UNIT_ENABLE: true,  TEMP_SETPOINT: 25, HUMIDITY_SETPOINT: 70, CO2_SETPOINT: 400, HUMIDITY_DEMAND: false, CO2_DEMAND: false, FAN_SCH: true,  HUMID_Sched: false, CO2_Sched: false, CO2_MACOST: false, CO2_MACOV: 800, HUMID_MAHOST: false, HUMID_MAHOV: 70, LIGHT1_sch: true,  LIGHT1_Manual: false },
    UNIT7:  { SPACE_TEMP: 20.1, RELATIVE_HUMIDITY: 60,  CO2: 408, UNIT_STATUS: 'Active',   UNIT_MODE: 'Heating', UNIT_ENABLE: true,  TEMP_SETPOINT: 20, HUMIDITY_SETPOINT: 60, CO2_SETPOINT: 400, HUMIDITY_DEMAND: false, CO2_DEMAND: false, FAN_SCH: true,  HUMID_Sched: false, CO2_Sched: false, CO2_MACOST: false, CO2_MACOV: 800, HUMID_MAHOST: false, HUMID_MAHOV: 60, LIGHT1_sch: false, LIGHT1_Manual: false },
    UNIT8:  { SPACE_TEMP: 23.8, RELATIVE_HUMIDITY: 67,  CO2: 395, UNIT_STATUS: 'Active',   UNIT_MODE: 'Cooling', UNIT_ENABLE: true,  TEMP_SETPOINT: 24, HUMIDITY_SETPOINT: 65, CO2_SETPOINT: 400, HUMIDITY_DEMAND: false, CO2_DEMAND: false, FAN_SCH: true,  HUMID_Sched: false, CO2_Sched: false, CO2_MACOST: false, CO2_MACOV: 800, HUMID_MAHOST: false, HUMID_MAHOV: 65, LIGHT1_sch: true,  LIGHT1_Manual: false },
    UNIT9:  { SPACE_TEMP: 18.9, RELATIVE_HUMIDITY: 52,  CO2: 425, UNIT_STATUS: 'Active',   UNIT_MODE: 'Standby', UNIT_ENABLE: true,  TEMP_SETPOINT: 19, HUMIDITY_SETPOINT: 55, CO2_SETPOINT: 400, HUMIDITY_DEMAND: false, CO2_DEMAND: false, FAN_SCH: false, HUMID_Sched: false, CO2_Sched: false, CO2_MACOST: false, CO2_MACOV: 800, HUMID_MAHOST: false, HUMID_MAHOV: 55, LIGHT1_sch: false, LIGHT1_Manual: false },
    UNIT10: { SPACE_TEMP: 22.0, RELATIVE_HUMIDITY: 63,  CO2: 410, UNIT_STATUS: 'Active',   UNIT_MODE: 'Heating', UNIT_ENABLE: true,  TEMP_SETPOINT: 22, HUMIDITY_SETPOINT: 62, CO2_SETPOINT: 400, HUMIDITY_DEMAND: false, CO2_DEMAND: false, FAN_SCH: true,  HUMID_Sched: false, CO2_Sched: false, CO2_MACOST: false, CO2_MACOV: 800, HUMID_MAHOST: false, HUMID_MAHOV: 62, LIGHT1_sch: true,  LIGHT1_Manual: false }
}

let MOCK_DATA = null

function cloneDefaultMockData() { return JSON.parse(JSON.stringify(DEFAULT_MOCK_DATA)) }

function loadPersistentState() {
    if (!hasStorage()) { MOCK_DATA = cloneDefaultMockData(); return false }
    try {
        const stored = localStorage.getItem(STATE_KEY)
        if (stored) {
            const parsed = JSON.parse(stored)
            if (Object.keys(DEFAULT_MOCK_DATA).every(unit => parsed[unit])) {
                MOCK_DATA = parsed; console.log('[ARC] Loaded persistent unit state.'); return true
            }
        }
    } catch (err) { console.warn('[ARC] Failed to parse stored unit state:', err) }
    return false
}

function savePersistentState() {
    if (!hasStorage() || !MOCK_DATA) return
    try { localStorage.setItem(STATE_KEY, JSON.stringify(MOCK_DATA)) }
    catch (err) { console.warn('[ARC] Failed to save unit state:', err) }
}

function initState() {
    if (!loadPersistentState()) { MOCK_DATA = cloneDefaultMockData(); savePersistentState(); console.log('[ARC] Initialized fresh mock unit state.') }
    Object.keys(DEFAULT_MOCK_DATA).forEach(unit => {
        if (!MOCK_DATA[unit]) MOCK_DATA[unit] = JSON.parse(JSON.stringify(DEFAULT_MOCK_DATA[unit]))
        Object.keys(DEFAULT_MOCK_DATA[unit]).forEach(key => { if (!(key in MOCK_DATA[unit])) MOCK_DATA[unit][key] = DEFAULT_MOCK_DATA[unit][key] })
    })
    savePersistentState()
}

// 7. SETPOINT STORAGE
function saveSetpointToStorage(unit, point, value) {
    if (!hasStorage()) return
    try { localStorage.setItem(`arc_setpoint_${unit}_${point}`, JSON.stringify(value)) } catch {}
}

function loadSetpointFromStorage(unit, point) {
    if (!hasStorage()) return undefined
    try { const raw = localStorage.getItem(`arc_setpoint_${unit}_${point}`); return raw !== null ? JSON.parse(raw) : undefined } catch { return undefined }
}

// 8. SIMULATION LOOP
const SENSOR_TARGETS = {
    TEMP_SETPOINT:     { sensor: 'SPACE_TEMP',        decimals: 1 },
    HUMIDITY_SETPOINT: { sensor: 'RELATIVE_HUMIDITY', decimals: 1 },
    CO2_SETPOINT:      { sensor: 'CO2',               decimals: 0 },
    HUMID_MAHOV:       { sensor: 'RELATIVE_HUMIDITY', decimals: 1 },
    CO2_MACOV:         { sensor: 'CO2',               decimals: 0 }
}

const SETPOINT_SETTLE_MS = 3000
const SIMULATION_TICK_MS = 250
const rampState = {}

function rampKey(unit, sensor) { return `${unit}_${sensor}` }

function startSensorRamp(unit, controlPoint, targetValue) {
    const cfg = SENSOR_TARGETS[controlPoint]
    if (!cfg || !MOCK_DATA?.[unit]) return
    const current = Number(MOCK_DATA[unit][cfg.sensor])
    const target  = Number(targetValue)
    if (!Number.isFinite(current) || !Number.isFinite(target)) return
    rampState[rampKey(unit, cfg.sensor)] = { from: current, to: target, start: Date.now(), duration: SETPOINT_SETTLE_MS, decimals: cfg.decimals }
}

function getActiveTarget(unit, sensor) {
    const data = MOCK_DATA?.[unit]; if (!data) return undefined
    if (sensor === 'SPACE_TEMP')        return data.TEMP_SETPOINT
    if (sensor === 'RELATIVE_HUMIDITY') return data.HUMID_MAHOST ? data.HUMID_MAHOV : data.HUMIDITY_SETPOINT
    if (sensor === 'CO2')               return data.CO2_MACOST   ? data.CO2_MACOV   : data.CO2_SETPOINT
    return undefined
}

function updateRampedSensor(unit, sensor, decimals) {
    const data = MOCK_DATA?.[unit]; if (!data || !data.UNIT_ENABLE) return
    const target = Number(getActiveTarget(unit, sensor)); if (!Number.isFinite(target)) return
    const key = rampKey(unit, sensor)
    let ramp = rampState[key]
    if (!ramp || ramp.to !== target) { ramp = { from: Number(data[sensor]), to: target, start: Date.now(), duration: SETPOINT_SETTLE_MS, decimals }; rampState[key] = ramp }
    const progress = Math.min(1, (Date.now() - ramp.start) / ramp.duration)
    data[sensor] = parseFloat((ramp.from + (ramp.to - ramp.from) * progress).toFixed(decimals))
    if (progress >= 1) { data[sensor] = parseFloat(Number(ramp.to).toFixed(decimals)); delete rampState[key] }
}

function syncSetpointsFromStorage() {
    if (!MOCK_DATA) return
    Object.keys(MOCK_DATA).forEach(unit => {
        ['TEMP_SETPOINT', 'HUMIDITY_SETPOINT', 'CO2_SETPOINT'].forEach(point => {
            const stored = loadSetpointFromStorage(unit, point)
            if (stored !== undefined) {
                if (MOCK_DATA[unit][point] !== stored) startSensorRamp(unit, point, stored)
                MOCK_DATA[unit][point] = stored
            }
        })
    })
}

// 9. HELPERS
function extractValue(data) {
    if (data === null || data === undefined) return null
    if (typeof data === 'object') {
        if ('value' in data)  return data.value
        if ('Value' in data)  return data.Value
        if ('out' in data)    return data.out
        if ('status' in data && 'display' in data) return data.display
    }
    return data
}

function logApiCall(op, unit, point, extra = null) {
    console.log(`[ARC] ${new Date().toISOString()} - ${op}: ${unit}/${point}`, extra || '')
}

function showToast(message, type = 'info') {
    if (hasWindow() && typeof window._showToast === 'function') { window._showToast(message, type); return }
    console.log(`[ARC] ${type.toUpperCase()}: ${message}`)
    if (typeof document === 'undefined') return
    const el  = document.getElementById('toast')
    const msg = document.getElementById('toastMessage')
    if (el && msg) {
        msg.textContent = message; el.classList.add('show')
        el.classList.toggle('error', type === 'error')
        setTimeout(() => el.classList.remove('show'), 3000)
    }
}

function updateMockPoint(unit, point, value) {
    if (!MOCK_DATA) initState()
    if (!MOCK_DATA?.[unit]) return false
    MOCK_DATA[unit][point] = value
    if (point === 'UNIT_ENABLE') {
        MOCK_DATA[unit].UNIT_STATUS = value ? 'Active' : 'Inactive'
        if (!value) MOCK_DATA[unit].UNIT_MODE = 'Off'
    }
    if (SENSOR_TARGETS[point]) { startSensorRamp(unit, point, value); saveSetpointToStorage(unit, point, value) }
    savePersistentState()
    return true
}

// ── WRITE SETTLE CHECK ──
// Returns true if a write just happened and Niagara needs time to settle.
// Callers should skip refresh during this window.
function isWriteSettling() {
    return _lastWriteTime > 0 && (Date.now() - _lastWriteTime) < WRITE_SETTLE_MS
}
if (hasWindow()) window.isWriteSettling = isWriteSettling

// ── HOLD (reassert) ──
// Workaround for points where something on the JACE side resets the value after our write
// verifies correctly (confirmed 2026-09-29 on UNIT_ENABLE and CO2_MACOV — write succeeds,
// read-back a moment later shows the old value again). This isn't a fix for whatever's
// resetting it station-side; it just re-checks and re-writes on an interval so the point
// spends its time at the value the operator actually asked for, instead of losing once and
// staying lost. Call stopHoldingPoint() the moment the operator turns something off, or this
// will keep fighting them.
const _holdIntervals = {}
function holdPointValue(unit, point, value, intervalMs = 5000) {
    const key = `${unit}/${point}`
    stopHoldingPoint(unit, point)
    _holdIntervals[key] = setInterval(async () => {
        try {
            const current = await readPoint(unit, point)
            if (current !== value) {
                console.log(`[ARC] HOLD: ${key} drifted to ${JSON.stringify(current)}, re-asserting ${JSON.stringify(value)}`)
                await writePoint(unit, point, value)
                // SAFETY (2026-10-01): a background HOLD write must NOT extend the
                // refresh-suppression window. setLiveGreenhousePoint() stamps _lastWriteTime
                // on every write; left unchecked, a hold firing every few seconds keeps
                // isWriteSettling() permanently true and freezes live refresh, pinning the
                // UI to locally-mocked values. Clearing the stamp here means isWriteSettling()
                // only ever reflects operator-initiated writes, never the hold loop.
                _lastWriteTime = 0
                if (hasWindow()) window._lastWriteTime = 0
            }
        } catch (err) {
            console.warn(`[ARC] HOLD check failed for ${key}:`, err && err.message ? err.message : err)
        }
    }, intervalMs)
    console.log(`[ARC] HOLD started: ${key} = ${JSON.stringify(value)} every ${intervalMs}ms`)
}
function stopHoldingPoint(unit, point) {
    const key = `${unit}/${point}`
    if (_holdIntervals[key]) {
        clearInterval(_holdIntervals[key])
        delete _holdIntervals[key]
        console.log(`[ARC] HOLD stopped: ${key}`)
    }
}
if (hasWindow()) { window.holdPointValue = holdPointValue; window.stopHoldingPoint = stopHoldingPoint }

// 10. READ POINT
async function readPoint(unit, point) {
    if (!MOCK_DATA) initState()

    if (!USE_LIVE_API) {
        logApiCall('READ MOCK', unit, point)
        _markLiveness(unit, point, true)  // intentional mock mode — nothing to compare against, not a failure
        return getMockValue(unit, point)
    }

    const slotPath = resolveSlotPath(unit, point)
    if (!slotPath) {
        // ✅ IMPROVED: explicit mock substitution warning so you can see it in console
        console.warn(`[ARC] ⚠️ MOCK SUBSTITUTION (no slot path): ${unit}/${point}`)
        _markLiveness(unit, point, false)
        return getMockValue(unit, point)
    }

    try {
        const url = `${normalizeBaseUrl(OSS_BASE_URL)}/query/readPoint/${encodeSlotPath(slotPath)}`
        logApiCall('READ LIVE', unit, point, slotPath)

        // Tested on-site 2026-09-30: PUT on readPoint returns 401 "No matching authorisation
        // token was found" — fails before it even reaches point lookup. GET is what actually works.
        const res  = await authedRequest(url, { method: 'GET' }, API_TIMEOUT)
        const data = await readResponseBody(res)

        if (!res.ok) {
            console.warn(`[ARC] ⚠️ MOCK SUBSTITUTION (HTTP ${res.status}): ${unit}/${point}`, data || '')
            _markLiveness(unit, point, false)
            return getMockValue(unit, point)
        }

        const value = extractValue(data)
        logApiCall('READ OK', unit, point, value)
        _markLiveness(unit, point, true)
        return value
    } catch (err) {
        console.warn(`[ARC] ⚠️ MOCK SUBSTITUTION (${isAbortError(err) ? 'timeout' : err.message}): ${unit}/${point}`)
        _markLiveness(unit, point, false)
        return getMockValue(unit, point)
    }
}

// 11. WRITE POINT
// priorityOverride: optional — defaults to WRITE_PRIORITY (16) for every point, same as
// always. Only setCo2Manual() passes an explicit override (see CO2_MANUAL_PRIORITY
// below); nothing else in the app is affected.
async function setLiveGreenhousePoint(unit, pointKey, targetValue, priorityOverride) {
    if (!MOCK_DATA) initState()

    if (!USE_LIVE_API) {
        const updated = updateMockPoint(unit, pointKey, targetValue)
        console.log(`[ARC] WRITE MOCK: ${unit}/${pointKey} = ${targetValue}`)
        return updated
    }

    const slotPath = resolveSlotPath(unit, pointKey)
    if (!slotPath) {
        console.warn(`[ARC] ⚠️ No slot path for ${unit}/${pointKey} — mock fallback`)
        return updateMockPoint(unit, pointKey, targetValue)
    }

    const priority = priorityOverride ?? WRITE_PRIORITY
    try {
        const url = `${normalizeBaseUrl(OSS_BASE_URL)}/query/writePoint/${encodeSlotPath(slotPath)}?value=${encodeURIComponent(targetValue)}&priority=${priority}`
        console.log(`[ARC] WRITE LIVE: ${unit}/${pointKey} = ${targetValue} (priority ${priority})`)

        const res  = await authedRequest(url, { method: 'PUT' }, API_TIMEOUT)
        const data = await readResponseBody(res)

        if (!res.ok) {
            console.warn(`[ARC] Write failed: ${unit}/${pointKey}: HTTP ${res.status}`, data || '')
            return false
        }

        // ✅ Stamp write time so refreshData() in control.html can suppress next refresh
        _lastWriteTime = Date.now()
        if (hasWindow()) window._lastWriteTime = _lastWriteTime

        updateMockPoint(unit, pointKey, targetValue)
        console.log(`[ARC] ✅ WRITE OK: ${unit}/${pointKey} = ${targetValue}`)
        return true
    } catch (err) {
        console.warn(`[ARC] writePoint failed: ${unit}/${pointKey}:`, isAbortError(err) ? 'timeout' : err.message)
        return false
    }
}

async function writePoint(unit, point, value, priorityOverride) {
    if (!MOCK_DATA) initState()
    const oldValue = getMockValue(unit, point)
    const success  = await setLiveGreenhousePoint(unit, point, value, priorityOverride)
    if (success) { logAuditAction(unit, point, value, oldValue) }
    else { showToast(`Failed to write ${unit}/${point}`, 'error') }
    return success
}

// ── DIAGNOSTIC ONLY — not wired into any UI flow yet ──
// Hypothesis, 2026-10-01: setCo2Manual's writes at WRITE_PRIORITY (16, the lowest
// BACnet priority) are accepted by the REST layer ("WRITE OK") but a read-back
// milliseconds later still shows the old value — too fast to be the hold-loop race
// already fixed. A commandable BACnet point's live value is whichever priority SLOT is
// highest (lowest number) and non-null, not whichever was written last. Earlier today a
// stale cached tab logged a write to CO2_MACOST at priority 1 (the highest possible) —
// if that was never relinquished, it would permanently out-rank every priority-16 write
// we make now, which matches the symptom exactly.
// This probes that theory by attempting to RELINQUISH (release) a given priority slot —
// i.e. write with no value at that priority, the standard BACnet way to clear a
// priority-array entry so a lower priority (or Auto/Relinquish-default) can take over.
// The exact query-string syntax this ossRestApiServer expects for "no value" is NOT
// confirmed. Attempt 1 (omit &value entirely) got HTTP 400 "Write request must contain
// a value parameter" — this server requires a value on every write, so bare omission
// doesn't work. Takes an explicit valueParam now so different conventions can be
// probed from the console without editing this file each time, e.g.:
//   await relinquishPriority('UNIT1', 'CO2_MACOST', 1, 'null')
//   await relinquishPriority('UNIT1', 'CO2_MACOST', 1, '')
// Run manually from the console and read back the point afterward; do not wire this
// into toggleOverride or any other flow until it's confirmed to do what we expect.
async function relinquishPriority(unit, point, priority, valueParam = 'null') {
    const slotPath = resolveSlotPath(unit, point)
    if (!slotPath) { console.warn(`[ARC] relinquishPriority: no slot path for ${unit}/${point}`); return false }
    try {
        const url = `${normalizeBaseUrl(OSS_BASE_URL)}/query/writePoint/${encodeSlotPath(slotPath)}?value=${encodeURIComponent(valueParam)}&priority=${priority}`
        console.log(`[ARC] RELINQUISH PROBE: ${unit}/${point} priority ${priority} value=${JSON.stringify(valueParam)} → ${url}`)
        const res  = await authedRequest(url, { method: 'PUT' }, API_TIMEOUT)
        const data = await readResponseBody(res)
        console.log(`[ARC] RELINQUISH PROBE result: HTTP ${res.status}`, data || '(empty body)')
        return res.ok
    } catch (err) {
        console.warn(`[ARC] RELINQUISH PROBE failed:`, isAbortError(err) ? 'timeout' : err.message)
        return false
    }
}
if (hasWindow()) window.relinquishPriority = relinquishPriority

// ── DIAGNOSTIC ONLY — raw read, no value extraction ──
// readPoint() extracts just the present value via extractValue() and discards the rest
// of the JSON body. If this ossRestApiServer's response includes a priority array (or
// any field showing who/what is forcing the value), extractValue() would be throwing
// it away unseen. This logs the FULL, unmodified response body so we can check.
async function rawReadPoint(unit, point) {
    const slotPath = resolveSlotPath(unit, point)
    if (!slotPath) { console.warn(`[ARC] rawReadPoint: no slot path for ${unit}/${point}`); return null }
    const url = `${normalizeBaseUrl(OSS_BASE_URL)}/query/readPoint/${encodeSlotPath(slotPath)}`
    const res  = await authedRequest(url, { method: 'GET' }, API_TIMEOUT)
    const data = await readResponseBody(res)
    console.log(`[ARC] RAW READ: ${unit}/${point} HTTP ${res.status}`, JSON.stringify(data, null, 2))
    return data
}
if (hasWindow()) window.rawReadPoint = rawReadPoint

// 12. MULTI-POINT
async function readMultiplePoints(unit, points) {
    if (!MOCK_DATA) initState()
    const results = {}
    await Promise.all((points || []).map(async point => { results[point] = await readPoint(unit, point) }))
    // _live: per-point liveness map (true = confirmed from this read, false = mock
    // substitution). Leading underscore avoids colliding with any real Niagara point
    // name (those are all CAPS_WITH_UNDERSCORES). See isPointLive() / _markLiveness().
    results._live = {}
    for (const point of (points || [])) { results._live[point] = isPointLive(unit, point) }
    return results
}

async function writeMultiplePoints(unit, writes) {
    if (!MOCK_DATA) initState()
    const results = {}
    for (const [point, value] of Object.entries(writes || {})) { results[point] = await writePoint(unit, point, value) }
    return results
}

// 12b. CO2 MANUAL SEQUENCE (engineer's documented order, write + verify)
// ───────────────────────────────────────────────────────────────────────────
// Added 2026-10-01. Niagara wire-sheet logic (per Aina):
//     MANUAL DEMAND = Manual Select AND Override AND NOT Schedule
//
// POINT TYPES CONFIRMED BY AINA (text, 2026-10-01):
//     CO2_MACOST  = BOOLEAN, writable  -> Manual CO2 Select
//     CO2_MACOV   = BOOLEAN, writable  -> CO2 Override ENABLE  (NOT a numeric value!)
//     CO2_C02SCH  = BOOLEAN schedule   -> schedule enable (key 'CO2_Sched' in SLOT_PATHS)
//
// The old toggleOverride('co2') wrote only CO2_MACOST and NEVER CO2_Sched / CO2_MACOV,
// so "Override" and "NOT Schedule" were never satisfied and manual demand could never
// assert. This helper performs ALL THREE confirmed boolean writes in Aina's documented
// order, awaiting + reading back each step:
//     ENABLE : CO2_Sched = false -> CO2_MACOST = true -> CO2_MACOV = true
//     DISABLE: CO2_MACOV = false -> CO2_MACOST = false -> CO2_Sched = true
// Priority stays WRITE_PRIORITY (16). No point is invented — all three already exist in
// SLOT_PATHS. No separate numeric override value is written here; CO2_MACOV is boolean.
//
// NOTE on the point key: use 'CO2_Sched' (the SLOT_PATHS resolver key that maps to
// .../CO2$2eC02SCH). The literal string 'CO2_C02SCH' has no resolver and would silently
// fall back to mock, so it must NOT be used here.
//
// Read-back is best-effort because the JACE response format for these points is not
// confirmed while Workbench is unavailable:
//   match === true   -> verified
//   match === null   -> value couldn't be parsed; treat as written-but-unverified,
//                        keep going (don't make the app unusable)
//   match === false  -> JACE actively reports the opposite; STOP, do not proceed
function _co2ValuesMatch(readBack, expected) {
    if (readBack === null || readBack === undefined) return null // unknown — can't verify
    const norm = v => {
        if (typeof v === 'boolean') return String(v)
        if (typeof v === 'number')  return v === 0 ? 'false' : v === 1 ? 'true' : String(v)
        const s = String(v).trim().toLowerCase().split(/[\s{]/)[0]
        if (['true', 'on', 'active', 'enabled', '1'].includes(s))      return 'true'
        if (['false', 'off', 'inactive', 'disabled', '0'].includes(s)) return 'false'
        return s
    }
    return norm(readBack) === norm(expected)
}

// CO2 was the first point type confirmed to need priority 1 (on-site console test).
// As of 2026-10-01, WRITE_PRIORITY itself is also 1 app-wide (same finding held true
// for lighting and irrigation too), so this constant is now redundant with the
// default — kept as its own named constant anyway so CO2's priority stays explicit and
// independently revertible here without touching the app-wide default.
const CO2_MANUAL_PRIORITY = 1

// CO2_Sched ("C02_C02SCH") DROPPED from this sequence, 2026-10-01: forcing it to false
// (to enter manual) failed its read-back even at priority 1 — the highest BACnet
// priority there is, which nothing can out-rank by priority alone. That means it isn't
// behaving like a plain writable point; it's most likely the live output of an actual
// Niagara Schedule component, which recomputes on its own evaluation cycle regardless
// of priority. Forcing it to true (during disable) only ever "succeeded" because that
// happened to match what the schedule already was outputting on its own, not because
// the write had real effect. Per Aina, proper control of this point means editing the
// schedule's configured time periods (a separate, not-yet-built feature), not writing
// its output directly. On user instruction (2026-10-01): stop writing to it and rely
// only on CO2_MACOST + CO2_MACOV — this means MANUAL DEMAND (which per Aina's wire-sheet
// logic is Manual Select AND Override AND NOT Schedule) will only actually assert at
// the physical valve during whatever hours the real schedule is naturally OFF, until
// the schedule-editing feature exists.
async function setCo2Manual(unit, enable) {
    // Both points are BOOLEAN (confirmed by Aina 2026-10-01).
    const seq = enable
        ? [['CO2_MACOST', true], ['CO2_MACOV', true]]     // ENABLE
        : [['CO2_MACOV', false], ['CO2_MACOST', false]]   // DISABLE

    // Settle delay before read-back, added 2026-10-01: this file already established
    // (WRITE_SETTLE_MS, Day 1) that this JACE can take real time to apply a write before
    // it shows up on a read. setCo2Manual never had that delay — it read back instantly,
    // which caught genuinely-successful writes mid-propagation and wrongly reported them
    // as conflicts (confirmed on-site: CO2_MACOST disable "conflicted" with an immediate
    // read, but our manual console test with a 1.5s wait before reading worked fine on
    // the exact same point/value). Matches the wait we proved works.
    const CO2_SETTLE_MS = 1500

    const steps = []
    for (const [point, value] of seq) {
        const ok = await writePoint(unit, point, value, CO2_MANUAL_PRIORITY)   // PUT (priority 1 — see above)
        if (!ok) {
            console.warn(`[ARC] setCo2Manual: write FAILED at ${point}`)
            return { ok: false, failedAt: point, written: value, steps }
        }
        await sleep(CO2_SETTLE_MS)
        const back  = await readPoint(unit, point)           // read-back
        const match = _co2ValuesMatch(back, value)           // true / false / null(unknown)
        steps.push({ point, written: value, readBack: back, verified: match === true })
        if (match === false) {
            console.warn(`[ARC] setCo2Manual: read-back CONFLICT at ${point} — JACE reports ${JSON.stringify(back)}, expected ${JSON.stringify(value)}`)
            return { ok: false, failedAt: point, written: value, readBack: back, steps }
        }
    }
    const verified = steps.every(s => s.verified)
    console.log(`[ARC] setCo2Manual(${unit}, enable=${enable}) ok, verified=${verified}`, steps)
    return { ok: true, verified, steps }
}
if (hasWindow()) window.setCo2Manual = setCo2Manual

// 13. AUDIT LOG
function logAuditAction(unit, point, value, oldValue) {
    try {
        let actionType = 'setpoint', action = `${point} changed`, details = `${point} -> ${value}`
        if (point === 'UNIT_ENABLE')                               { actionType = value ? 'enable':'disable'; action = value ? 'Unit Enabled':'Unit Disabled'; details = value ? 'Unit turned ON':'Unit turned OFF' }
        else if (['HUMIDITY_DEMAND','CO2_DEMAND'].includes(point)) { actionType = 'toggle'; action = `${point} ${value?'ON':'OFF'}`; details = `${point} ${value?'enabled':'disabled'}` }
        else if (['CO2_MACOST','HUMID_MAHOST'].includes(point))    { actionType = 'override'; const lbl = point === 'CO2_MACOST' ? 'CO2':'Humidity'; action = `${lbl} Override ${value?'ON':'OFF'}`; details = action }
        else if (point === 'CO2_Sched')                            { actionType = 'toggle'; action = `CO2 Schedule ${value?'ON':'OFF'}`; details = `CO2_Sched -> ${value}` }
        else if (point === 'LIGHT1_Manual')                        { actionType = 'uv'; action = `UV Lights ${value?'ON':'OFF'}`; details = action }
        else if (point === 'TEMP_SETPOINT')                        { action = 'Temperature Setpoint Changed'; details = `${oldValue} C -> ${value} C` }
        else if (point === 'HUMIDITY_SETPOINT')                    { action = 'Humidity Setpoint Changed'; details = `${oldValue}% -> ${value}%` }
        else if (point === 'CO2_SETPOINT')                         { action = 'CO2 Setpoint Changed'; details = `${oldValue} ppm -> ${value} ppm` }
        else if (['CO2_MACOV','HUMID_MAHOV'].includes(point))      { return }
        if (hasWindow() && typeof window.addAuditEntry === 'function') window.addAuditEntry({ unit, action, actionType, details, oldValue, newValue: value })
        else addAuditEntry({ unit, action, actionType, details, oldValue, newValue: value })
    } catch (err) { console.warn('[ARC] Audit write failed:', err) }
}

function addAuditEntry(entry) {
    if (!hasStorage()) return
    try {
        const log = JSON.parse(localStorage.getItem('arc_audit_log') || '[]')
        log.unshift({ id: `${Date.now()}_${Math.random().toString(36).slice(2,8)}`, timestamp: new Date().toISOString(), user: localStorage.getItem('arc_user')||'Unknown', unit: entry.unit||'System', action: entry.action||'Unknown', actionType: entry.actionType||'info', details: entry.details||'', oldValue: entry.oldValue??null, newValue: entry.newValue??null, device: typeof navigator !== 'undefined' ? navigator.userAgent : 'Unknown', ip: entry.ip||'Local' })
        if (log.length > 1000) log.length = 1000
        localStorage.setItem('arc_audit_log', JSON.stringify(log))
    } catch (err) { console.warn('[ARC] Audit log failed:', err) }
}

// 14. MISC
function getMockData()           { if (!MOCK_DATA) initState(); return MOCK_DATA }
function setMockData(data)       { if (!MOCK_DATA) initState(); Object.assign(MOCK_DATA, data || {}); savePersistentState() }
async function checkApiHealth()  { return await isN4Reachable() }
function refreshConnectionStatus() { _ossReachable = null; _lastConnectionCheck = 0; clearCachedToken(); console.log('[ARC] Connection and token cache cleared.') }
function getConnectionStatus()   { return _ossReachable }

function resetUnitState() {
    const ok = typeof confirm === 'function' ? confirm('Reset ALL units to default state?') : true
    if (!ok) return
    MOCK_DATA = cloneDefaultMockData(); savePersistentState()
    Object.keys(rampState).forEach(key => delete rampState[key])
    console.log('[ARC] Units reset.')
    if (typeof location !== 'undefined') location.reload()
}

// 15. INITIALIZATION
initState()
syncSetpointsFromStorage()

if (typeof setInterval === 'function') {
    setInterval(() => {
        if (USE_LIVE_API || !MOCK_DATA) return
        syncSetpointsFromStorage()
        Object.keys(MOCK_DATA).forEach(unit => {
            const data = MOCK_DATA[unit]; if (!data.UNIT_ENABLE) return
            updateRampedSensor(unit, 'SPACE_TEMP', 1)
            updateRampedSensor(unit, 'RELATIVE_HUMIDITY', 1)
            updateRampedSensor(unit, 'CO2', 0)
            if (Number(data.SPACE_TEMP) < Number(data.TEMP_SETPOINT))      data.UNIT_MODE = 'Heating'
            else if (Number(data.SPACE_TEMP) > Number(data.TEMP_SETPOINT)) data.UNIT_MODE = 'Cooling'
            else                                                             data.UNIT_MODE = 'Standby'
        })
        savePersistentState()
    }, SIMULATION_TICK_MS)
}

console.log('[ARC] ARC Glasshouse API — ossRestApiServer Live Telemetry Core')
console.log(`[ARC] Mode:     ${USE_LIVE_API ? '🔴 LIVE API' : '🟡 MOCK DATA'}`)
console.log(`[ARC] Base URL: ${OSS_BASE_URL}`)
console.log(`[ARC] Priority: ${WRITE_PRIORITY} (highest BACnet priority — raised 2026-10-01 so this app's writes win over any other system, including Aina's interface)`)
console.log(`[ARC] Units:    ${Object.keys(MOCK_DATA || {}).length}`)
console.log('[ARC] Quick tests: await listPoints(), await readPoint("UNIT1","SPACE_TEMP"), await writePoint("UNIT1","TEMP_SETPOINT",24)')

if (USE_LIVE_API) {
    setTimeout(async () => {
        const token = await getToken()
        console.log(`[ARC] Startup: ${token ? '✅ Token OK — live mode active' : '❌ Token failed — mock fallback'}`)
    }, 1000)
}

// 15b. STRICT SCHEDULER POINTS (UV lighting + irrigation)
// These functions NEVER fall back to mock data. Every result is either the value
// the JACE returned or the real error. Slot paths are not hardcoded: Aina supplied
// point NAMES (LightSch_n, ValveSch_n, VALVE_n) and the irrigation folders, but not
// the full slot paths, so they are resolved from the JACE's own /query/listPoints.
const SCHEDULE_NAME_RE   = /^(LightSch|ValveSch|VALVE)_(\d{1,2})$/
const READ_ONLY_NAME_RE  = /^VALVE_\d{1,2}$/          // Aina: VALVE_1..10 are read-only state points
const DISCOVERY_TTL_MS   = 5 * 60 * 1000
const DISCOVERY_RETRY_MS = 30 * 1000
const VERIFY_DELAY_MS    = 1200                       // let Niagara apply the write before read-back
let _schedIndex = null            // { at, byName: {name: [paths]}, total }
let _schedIndexPromise = null
let _schedIndexError = null       // { at, error }

function describeHttpError(status, body) {
    const detail = body === null || body === undefined || body === '' ? '' : (typeof body === 'string' ? body : JSON.stringify(body))
    const short  = detail.length > 300 ? detail.slice(0, 300) + '…' : detail
    let head
    if (status === 400)                      head = 'JACE returned HTTP 400'
    else if (status === 401 || status === 403) head = `JACE rejected the credentials/permissions (HTTP ${status})`
    else if (status === 404)                 head = 'JACE returned HTTP 404 (point or endpoint not found)'
    else if (status >= 500)                  head = `JACE returned HTTP ${status} (server error)`
    else                                     head = `JACE returned HTTP ${status}`
    return short ? `${head}: ${short}` : `${head}.`
}

function describeException(err) {
    if (isAbortError(err)) return `Request timed out after ${API_TIMEOUT / 1000}s — JACE unreachable or not responding.`
    const msg = err && err.message ? err.message : String(err)
    if (msg === 'Authentication token unavailable.' || msg === 'Token refresh failed.') return `${msg} The JACE did not issue a token (unreachable, or the OAuth credentials were rejected) — see the "[ARC] Token"/"Authentication failed" line in the browser console for the exact response.`
    if (err && err.name === 'TypeError') return `Network error — JACE unreachable (check LAN/certificate): ${msg}`
    return msg
}

function collectPointPaths(data, out = []) {
    if (typeof data === 'string') { if (data.includes('/')) out.push(data); return out }
    if (Array.isArray(data))      { data.forEach(d => collectPointPaths(d, out)); return out }
    if (data && typeof data === 'object') Object.values(data).forEach(v => collectPointPaths(v, out))
    return out
}

async function discoverSchedulePoints(force = false) {
    const now = Date.now()
    if (!force && _schedIndex && now - _schedIndex.at < DISCOVERY_TTL_MS) return { ok: true, index: _schedIndex }
    if (!force && !_schedIndex && _schedIndexError && now - _schedIndexError.at < DISCOVERY_RETRY_MS) return { ok: false, error: _schedIndexError.error }
    if (_schedIndexPromise) return _schedIndexPromise

    _schedIndexPromise = (async () => {
        try {
            const res  = await authedRequest(`${normalizeBaseUrl(OSS_BASE_URL)}/query/listPoints`, { method: 'GET' }, API_TIMEOUT)
            const body = await readResponseBody(res)
            if (!res.ok) throw Object.assign(new Error(`Unable to list JACE points. ${describeHttpError(res.status, body)}`), { reported: true })
            const paths = collectPointPaths(body)
            if (!paths.length) throw Object.assign(new Error('Unable to list JACE points. listPoints returned no slot paths (unexpected response shape).'), { reported: true })
            const byName = {}
            for (const p of paths) {
                const clean = String(p).replace(/^\/+/, '')
                const last  = clean.split('/').filter(Boolean).pop()
                if (last && SCHEDULE_NAME_RE.test(last)) (byName[last] = byName[last] || []).push(clean)
            }
            _schedIndex = { at: Date.now(), byName, total: paths.length }
            _schedIndexError = null
            console.log(`[ARC] Scheduler discovery: ${Object.keys(byName).length} scheduler points found among ${paths.length} JACE points`)
            return { ok: true, index: _schedIndex }
        } catch (err) {
            const msg = err && err.reported ? err.message : `Unable to list JACE points. ${describeException(err)}`
            _schedIndexError = { at: Date.now(), error: msg }
            console.warn('[ARC] Scheduler discovery failed:', msg)
            return { ok: false, error: msg }
        } finally {
            _schedIndexPromise = null
        }
    })()
    return _schedIndexPromise
}

// Resolve a point name (e.g. "VALVE_3") to the JACE's own slot path. Never guesses.
// Irrigation lives on a SEPARATE controller from UNIT1..10 (confirmed by Aina 2026-09-29,
// WhatsApp): units 1-8 under Irrigation_1to8, units 9-10 under Irrigation_9to10, both still
// under Drivers/BacnetNetwork. That's a different branch of the point tree than the one
// discoverSchedulePoints() scans for LightSch_n, which is why every prior listPoints scan
// came back empty — the points were never missing, just outside the scanned tree. So unlike
// LightSch_n (discovered by name), Valve/ValveSch points are resolved directly, no discovery.
const IRRIGATION_NAME_RE = /^(ValveSch|VALVE)_(\d{1,2})$/
function irrigationSlotPath(name) {
    const m = IRRIGATION_NAME_RE.exec(String(name))
    if (!m) return null
    const [, prefix, nStr] = m
    const n = Number(nStr)
    if (n < 1 || n > 10) return null
    // Confirmed on-site 2026-09-30: Aina copied the real ORD straight out of Workbench —
    // station:|slot:/Drivers/BacnetNetwork/Irrigation_Valves$201$2d8/points/ValveSch_1
    // The $-escape isn't just a display artifact — it's literally baked into the component's
    // real slot name (Niagara escapes disallowed chars like space/hyphen into the name itself
    // at creation time). That's why every human-readable guess ("Irrigation_Valves 1-8", with
    // a real space and dash) kept coming back "not allocated" — that name genuinely doesn't
    // exist. Only the raw escaped string does. So we use it as-is, not decoded:
    const folder = n <= 8 ? 'Irrigation_Valves$201$2d8' : 'Irrigation_Valves$209$2d10'
    return `Drivers/BacnetNetwork/${folder}/points/${prefix}_${n}`
}

async function getSchedulePointPath(name) {
    if (!SCHEDULE_NAME_RE.test(String(name))) return { ok: false, error: `${name} is not a recognised scheduler point name.` }
    const irr = irrigationSlotPath(name)
    if (irr) return { ok: true, slotPath: irr }
    let d = await discoverSchedulePoints(false)
    if (!d.ok) return { ok: false, error: d.error }
    let paths = d.index.byName[name]
    if (!paths) {                                             // maybe the point was added since the last scan
        d = await discoverSchedulePoints(true)
        if (!d.ok) return { ok: false, error: d.error }
        paths = d.index.byName[name]
    }
    if (!paths || !paths.length) return { ok: false, error: `${name} was not found in the JACE point list (${d.index.total} points scanned). Point missing or not allocated.` }
    if (paths.length > 1)        return { ok: false, error: `${name} is ambiguous — found at ${paths.length} paths: ${paths.join(' | ')}` }
    return { ok: true, slotPath: paths[0] }
}

async function strictReadSlot(slotPath, label) {
    try {
        const url  = `${normalizeBaseUrl(OSS_BASE_URL)}/query/readPoint/${encodeSlotPath(slotPath)}`
        logApiCall('READ STRICT', label, slotPath)
        // Tested on-site 2026-09-30: PUT on readPoint returns 401 "No matching authorisation
        // token was found" — fails before it even reaches point lookup. GET is what actually works.
        const res  = await authedRequest(url, { method: 'GET' }, API_TIMEOUT)
        const body = await readResponseBody(res)
        if (!res.ok) return { ok: false, status: res.status, slotPath, raw: body, error: `Unable to read ${label}. ${describeHttpError(res.status, body)}` }
        const value = extractValue(body)
        if (value === null || value === undefined) return { ok: false, status: res.status, slotPath, raw: body, error: `Unable to read ${label}. Unexpected/empty response from JACE: ${JSON.stringify(body)}` }
        return { ok: true, value, raw: body, slotPath, readAt: Date.now() }
    } catch (err) {
        return { ok: false, slotPath, error: `Unable to read ${label}. ${describeException(err)}` }
    }
}

async function readSchedulePoint(name) {
    const p = await getSchedulePointPath(name)
    if (!p.ok) return { ok: false, error: `Unable to read ${name}. ${p.error}` }
    return strictReadSlot(p.slotPath, name)
}

function scheduleValuesMatch(a, b) {
    const norm = v => {
        if (typeof v === 'boolean') return String(v)
        if (typeof v === 'number')  return String(v)
        const s = String(v).trim().toLowerCase().split(/[\s{]/)[0]
        return s
    }
    return norm(a) === norm(b)
}

// WRITE -> VERIFY against a known slot path. Shared by every strict writer below.
// Returns { ok, verified, ... }. ok=false means the write did not happen.
// verified === true only when a fresh read-back from the JACE equals the value written.
async function writeAndVerifySlot(slotPath, label, value, oldValue, unitLabel, auditType) {
    const audit = (action, details) => { try { addAuditEntry({ unit: unitLabel, action, actionType: auditType, details, oldValue, newValue: value }) } catch {} }
    try {
        const url = `${normalizeBaseUrl(OSS_BASE_URL)}/query/writePoint/${encodeSlotPath(slotPath)}?value=${encodeURIComponent(value)}&priority=${WRITE_PRIORITY}`
        console.log(`[ARC] WRITE STRICT: ${label} = ${value} (priority ${WRITE_PRIORITY}) → ${slotPath}`)
        const res  = await authedRequest(url, { method: 'PUT' }, API_TIMEOUT)
        const body = await readResponseBody(res)
        if (!res.ok) {
            const error = `Unable to write ${label}. ${describeHttpError(res.status, body)}`
            audit(`${label} write failed`, error)
            return { ok: false, verified: false, status: res.status, error }
        }
        _lastWriteTime = Date.now()
        if (hasWindow()) window._lastWriteTime = _lastWriteTime

        await new Promise(r => setTimeout(r, VERIFY_DELAY_MS))
        const back = await strictReadSlot(slotPath, label)
        if (!back.ok) {
            audit(`${label} written (unverified)`, `${label} -> ${value}; read-back failed`)
            return { ok: true, verified: false, written: value, error: `${label} write was accepted (HTTP ${res.status}) but the read-back failed. ${back.error}` }
        }
        const verified = scheduleValuesMatch(back.value, value)
        audit(`${label} ${verified ? 'written' : 'written (JACE differs)'}`, `${label} -> ${value}; read-back ${JSON.stringify(back.value)}`)
        return {
            ok: true, verified, written: value, readBack: back.value, readBackRaw: back.raw,
            error: verified ? null : `${label} write was accepted (HTTP ${res.status}) but the JACE now reports ${JSON.stringify(back.value)}, not ${JSON.stringify(value)}.`
        }
    } catch (err) {
        const error = `Unable to write ${label}. ${describeException(err)}`
        audit(`${label} write failed`, error)
        return { ok: false, verified: false, error }
    }
}

async function writeSchedulePoint(name, value, oldValue = null, unitLabel = 'System') {
    if (READ_ONLY_NAME_RE.test(String(name))) {
        return { ok: false, verified: false, error: `${name} is a read-only valve state point. Write refused.` }
    }
    if (!/^(LightSch|ValveSch)_\d{1,2}$/.test(String(name))) {
        return { ok: false, verified: false, error: `${name} is not a writable scheduler point.` }
    }
    const p = await getSchedulePointPath(name)
    if (!p.ok) return { ok: false, verified: false, error: `Unable to write ${name}. ${p.error}` }
    return writeAndVerifySlot(p.slotPath, name, value, oldValue, unitLabel, name.startsWith('LightSch') ? 'uv' : 'toggle')
}

// ── Confirmed-real named point (via SLOT_PATHS/resolveSlotPath), strict (no mock fallback) ──
// Use this for points already confirmed to exist under a known resolver — e.g. the single
// UV on/off point per unit (LIGHT1_sch/LIGHT1_Manual -> UNITn_LIGHT, UNIT9/UNIT10 have no
// "_LIGHT" suffix on this JACE, confirmed on-site 2026-09-28). Unlike readPoint/writePoint,
// this NEVER substitutes mock data.
async function strictReadNamedPoint(unit, point, label) {
    const slotPath = resolveSlotPath(unit, point)
    if (!slotPath) return { ok: false, error: `Unable to read ${label}. No known slot path for ${unit}/${point}.` }
    return strictReadSlot(slotPath, label)
}

async function strictWriteNamedPoint(unit, point, value, oldValue, unitLabel, label, auditType) {
    const slotPath = resolveSlotPath(unit, point)
    if (!slotPath) return { ok: false, verified: false, error: `Unable to write ${label}. No known slot path for ${unit}/${point}.` }
    return writeAndVerifySlot(slotPath, label, value, oldValue, unitLabel, auditType)
}

async function readUvLightPoint(unitNum) {
    return strictReadNamedPoint('UNIT' + unitNum, 'LIGHT1_sch', `UV light (Unit ${unitNum})`)
}

async function writeUvLightPoint(unitNum, value, oldValue = null) {
    return strictWriteNamedPoint('UNIT' + unitNum, 'LIGHT1_sch', value, oldValue, 'Greenhouse ' + unitNum, `UV light (Unit ${unitNum})`, 'uv')
}

// 16. GLOBAL ACCESS
if (hasWindow()) {
    window.readSchedulePoint        = readSchedulePoint
    window.writeSchedulePoint       = writeSchedulePoint
    window.discoverSchedulePoints   = discoverSchedulePoints
    window.readUvLightPoint         = readUvLightPoint
    window.writeUvLightPoint        = writeUvLightPoint
    window.strictReadNamedPoint     = strictReadNamedPoint
    window.strictWriteNamedPoint    = strictWriteNamedPoint
    window.isPointLive              = isPointLive
    window.USE_LIVE_API             = USE_LIVE_API
    window.MOCK_DATA                = MOCK_DATA
    window.readPoint                = readPoint
    window.writePoint               = writePoint
    window.readMultiplePoints       = readMultiplePoints
    window.writeMultiplePoints      = writeMultiplePoints
    window.checkApiHealth           = checkApiHealth
    window.getMockData              = getMockData
    window.setMockData              = setMockData
    window.refreshConnectionStatus  = refreshConnectionStatus
    window.getConnectionStatus      = getConnectionStatus
    window.isN4Reachable            = isN4Reachable
    window.getToken                 = getToken
    window.reauthenticateAfter401   = reauthenticateAfter401
    window.fetchLiveGreenhouseTelemetry = fetchLiveGreenhouseTelemetry
    window.setLiveGreenhousePoint   = setLiveGreenhousePoint
    window.savePersistentState      = savePersistentState
    window.loadPersistentState      = loadPersistentState
    window.initState                = initState
    window.resetUnitState           = resetUnitState
    window.addAuditEntry            = addAuditEntry
    window.listPoints               = listPoints
    window.getSlotPathMap           = getSlotPathMap
    window.saveSlotPathMap          = saveSlotPathMap
    window.setSlotPath              = setSlotPath
    window.resolveSlotPath          = resolveSlotPath
    window.isWriteSettling          = isWriteSettling
    window._lastWriteTime           = _lastWriteTime
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { USE_LIVE_API, MOCK_DATA, readPoint, writePoint, readMultiplePoints, writeMultiplePoints, getMockData, setMockData, checkApiHealth, refreshConnectionStatus, getConnectionStatus, isN4Reachable, getToken, fetchLiveGreenhouseTelemetry, setLiveGreenhousePoint, addAuditEntry, resetUnitState, initState, listPoints, getSlotPathMap, saveSlotPathMap, setSlotPath, resolveSlotPath, isWriteSettling, setCo2Manual, readSchedulePoint, writeSchedulePoint, discoverSchedulePoints, getSchedulePointPath, describeHttpError, readUvLightPoint, writeUvLightPoint, strictReadNamedPoint, strictWriteNamedPoint, reauthenticateAfter401, isPointLive }
}