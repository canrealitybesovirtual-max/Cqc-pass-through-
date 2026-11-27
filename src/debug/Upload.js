// @ts-check
/**
 * Automatic diagnostics upload (v0.4, the user's chosen extra 10): the last
 * session's compact record goes to the user's private Supabase project
 * `cqc-pass-through`, table `public.diagnostics` (columns app, version, kind,
 * mode, device, payload jsonb under 1.5 MB, created_at). The anon role may
 * only INSERT (Row Level Security); the publishable key is public by design.
 * Claude reads the table with the Supabase MCP `execute_sql`.
 *
 * - When: at session end, after the record is saved (App, from a setTimeout:
 *   never from the frame loop), and on the page's Copy press.
 * - How: one `fetch` POST (PostgREST, `Prefer: return=minimal`). A body of at
 *   most 64 KB goes with `keepalive` (it survives the page closing); a larger
 *   one goes without it (the session has ended, the page is still open). A
 *   browser that refuses the keepalive request (its CORS preflight) is asked
 *   again without it.
 * - Failure: the request body waits in localStorage (`cqcpt.upload.v1`, at
 *   most 3, the oldest dropped) and is sent again on the next page load.
 * - Never: dev builds (localhost, `?dev`) and `?emulate` do not upload, unless
 *   the URL says `?upload=1`; `?upload=0` turns it off anywhere.
 * - Size: the payload stays under the table's 1.5 MB (the encoded global mesh
 *   goes first, then the hitch log; at worst only a stub with the size is sent).
 *
 * Pure: no DOM, no three.js (`fetch` and the storage are injected), so it is
 * tested in Node.
 */
import { snapshotForCopy } from '../world/Snapshot.js';

export const UPLOAD = Object.freeze({
  url: 'https://ysxcottwabhpajhcnbqr.supabase.co/rest/v1/diagnostics',
  key: 'sb_publishable_YNOltLcjVFMzeljWuHbzdg_sWCdgrfh',
  app: 'cqc-pass-through',
  /** fetch keepalive's body limit (bytes, the Fetch spec's 64 KiB in flight per page). */
  keepaliveMax: 64 * 1024,
  /** Bytes of JSON the payload may have (the table takes under 1.5 MB). */
  payloadMax: 1400 * 1024,
  /** Uploads waiting for the next page load. */
  maxPending: 3,
  /** Attempts per waiting upload before it is dropped. */
  maxTries: 5,
  pendingKey: 'cqcpt.upload.v1',
  timeoutMs: 20000,
});

/** The states the page shows. */
export const UPLOAD_TEXT = Object.freeze({
  off: 'Automatic upload off (dev build or emulator)',
  idle: '',
  sending: 'Sending…',
  sent: 'Sent ✓',
  retry: 'Will retry',
});

/**
 * UTF-8 byte length of a string (no allocation).
 * @param {string} s
 */
export function utf8Length(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

/**
 * A short device line from the user agent: "Quest 3 · OculusBrowser 37.0 · Chrome 134".
 * @param {string} ua
 */
export function shortDevice(ua) {
  const s = String(ua || '');
  /** @type {string[]} */ const parts = [];
  const q = /Quest(?: Pro| \d+S?)?/i.exec(s);
  if (q) parts.push(q[0]);
  const ob = /OculusBrowser\/(\d+(?:\.\d+)?)/.exec(s);
  if (ob) parts.push(`OculusBrowser ${ob[1]}`);
  const ch = /(Headless)?Chrome\/(\d+)/.exec(s);
  if (ch) parts.push(`${ch[1] ? 'HeadlessChrome' : 'Chrome'} ${ch[2]}`);
  if (!parts.length) {
    const f = /(Firefox|Version)\/(\d+)/.exec(s);
    if (f) parts.push(`${f[1] === 'Version' ? 'Safari' : f[1]} ${f[2]}`);
  }
  if (!parts.length) {
    const os = /\(([^)]*)\)/.exec(s);
    if (os) parts.push(os[1].split(';')[0].trim());
  }
  return (parts.join(' · ') || s.slice(0, 60) || 'unknown').slice(0, 120);
}

/**
 * Whether this page uploads: production builds only (not dev, not ?emulate), unless ?upload=1; ?upload=0 never.
 * @param {boolean} dev @param {URLSearchParams} params
 */
export function uploadEnabled(dev, params) {
  const u = params.get('upload');
  if (u === '0') return false;
  if (u === '1') return true;
  return !dev && !params.has('emulate');
}

/**
 * The payload made to fit the table: unchanged when small enough; else the sessions' encoded global
 * mesh goes, then their hitch logs and recent frames, and at worst only a stub with the size.
 * Never changes the given object.
 * @param {any} payload @param {number} [max] bytes of JSON
 * @returns {{ payload: any, bytes: number, trimmed: string[] }}
 */
export function compactPayload(payload, max = UPLOAD.payloadMax) {
  /** @type {string[]} */ const trimmed = [];
  let p = payload, bytes = utf8Length(JSON.stringify(p ?? null));
  if (bytes <= max) return { payload: p, bytes, trimmed };
  const sessions = p && Array.isArray(p.sessions) ? p.sessions : [];
  p = { ...p, sessions: sessions.map((s) => (s && s.spaceSnapshot ? { ...s, spaceSnapshot: snapshotForCopy(s.spaceSnapshot) } : s)) };
  trimmed.push('mesh');
  bytes = utf8Length(JSON.stringify(p));
  if (bytes <= max) return { payload: p, bytes, trimmed };
  p = { ...p, sessions: p.sessions.map((/** @type {any} */ s) => {
    if (!s || typeof s !== 'object') return s;
    const { hitches, recent, ...rest } = s;
    return { ...rest, hitchesOmitted: !!hitches, recentOmitted: !!recent };
  }) };
  trimmed.push('hitches');
  bytes = utf8Length(JSON.stringify(p));
  if (bytes <= max) return { payload: p, bytes, trimmed };
  const stub = { app: payload && payload.app, version: payload && payload.version, truncated: true, bytes,
    sessions: sessions.map((/** @type {any} */ s) => (s ? { mode: s.mode, startedAt: s.startedAt, endedAt: s.endedAt, errors: Array.isArray(s.errors) ? s.errors.slice(0, 10) : [] } : null)) };
  trimmed.push('all');
  return { payload: stub, bytes: utf8Length(JSON.stringify(stub)), trimmed };
}

/**
 * @typedef {{ ok: boolean, status: number, bytes: number, keepalive: boolean, error?: string, ms: number }} PostResult
 * @typedef {{ kind: string, mode: string, body: string, tries: number, at: string }} Pending
 */

export class Uploader {
  /**
   * @param {{ enabled?: boolean, fetch?: any, storage?: Storage|null, onStatus?: ((s: { state: string, text: string, detail: string }) => void)|null,
   *   version?: string, ua?: string, url?: string, key?: string, now?: () => number }} [o]
   *   fetch: the page's fetch (injectable); storage: localStorage (pending uploads); onStatus: the page's status line
   */
  constructor(o = {}) {
    this.enabled = o.enabled !== false;
    this.fetch = o.fetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    this.storage = o.storage || null;
    this.onStatus = o.onStatus || null;
    this.version = o.version || '';
    this.ua = o.ua || '';
    this.url = o.url || UPLOAD.url;
    this.key = o.key || UPLOAD.key;
    this.now = o.now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    /** 'off' | 'idle' | 'sending' | 'sent' | 'retry' */
    this.state = this.enabled ? 'idle' : 'off';
    this.detail = '';
    this.sent = 0;
    this.failed = 0;
    this.retried = 0;
    /** The last attempts (newest last, at most 10): what the device's network did. @type {any[]} */
    this.log = [];
  }

  /** The request headers (PostgREST insert, no row echoed back). */
  headers() {
    return { apikey: this.key, Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' };
  }

  /**
   * One table row.
   * @param {string} kind 'session' | 'copy' | 'test' @param {string} mode @param {any} payload
   */
  row(kind, mode, payload) {
    return { app: UPLOAD.app, version: this.version, kind, mode: mode || '', device: shortDevice(this.ua), payload };
  }

  /**
   * Upload one payload. On failure (network, HTTP ≥ 300) it waits in storage for the next page load
   * (not for kind 'test'). Never throws.
   * @param {string} kind @param {string} mode @param {any} payload
   * @returns {Promise<PostResult & { skipped?: string, trimmed?: string[] }>}
   */
  async send(kind, mode, payload) {
    if (!this.enabled) return { ok: false, status: 0, bytes: 0, keepalive: false, ms: 0, skipped: 'off' };
    /** @type {string} */ let body;
    /** @type {string[]} */ let trimmed = [];
    try {
      const c = compactPayload(payload);
      trimmed = c.trimmed;
      body = JSON.stringify(this.row(kind, mode, c.payload));
    } catch (e) {
      this.setStatus('retry', `not sent: ${errText(e)}`);
      return { ok: false, status: 0, bytes: 0, keepalive: false, ms: 0, error: errText(e) };
    }
    this.setStatus('sending', `${kind}, ${kb(utf8Length(body))}`);
    const r = await this.post(body);
    this.note(kind, r);
    if (r.ok) {
      this.sent++;
      this.setStatus('sent', `${kind}, ${kb(r.bytes)}${trimmed.length ? `, trimmed: ${trimmed.join(', ')}` : ''}`);
    } else {
      this.failed++;
      if (kind !== 'test') this.addPending({ kind, mode: mode || '', body, tries: 1, at: new Date().toISOString() });
      this.setStatus('retry', `${kind}: ${r.status ? `HTTP ${r.status}` : r.error || 'network error'}`);
    }
    return { ...r, trimmed };
  }

  /**
   * POST a body: with keepalive when it is small enough (asked again without it when the browser refuses).
   * @param {string} body
   * @returns {Promise<PostResult>}
   */
  async post(body) {
    const t0 = this.now();
    const bytes = utf8Length(body);
    if (!this.fetch) return { ok: false, status: 0, bytes, keepalive: false, error: 'no fetch', ms: 0 };
    const small = bytes <= UPLOAD.keepaliveMax;
    try {
      const res = await this.request(body, small);
      return { ok: res.status >= 200 && res.status < 300, status: res.status, bytes, keepalive: small, ms: Math.round(this.now() - t0) };
    } catch (e) {
      if (!small) return { ok: false, status: 0, bytes, keepalive: false, error: errText(e), ms: Math.round(this.now() - t0) };
      try {
        const res = await this.request(body, false);
        return { ok: res.status >= 200 && res.status < 300, status: res.status, bytes, keepalive: false, error: `keepalive refused: ${errText(e)}`, ms: Math.round(this.now() - t0) };
      } catch (e2) {
        return { ok: false, status: 0, bytes, keepalive: false, error: errText(e2), ms: Math.round(this.now() - t0) };
      }
    }
  }

  /**
   * @param {string} body @param {boolean} keepalive
   * @returns {Promise<{ status: number }>}
   */
  async request(body, keepalive) {
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ac ? setTimeout(() => ac.abort(), UPLOAD.timeoutMs) : null;
    try {
      /** @type {any} */ const init = { method: 'POST', headers: this.headers(), body, keepalive, mode: 'cors', credentials: 'omit' };
      if (ac) init.signal = ac.signal;
      return await this.fetch(this.url, init);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** @returns {Pending[]} the uploads waiting for a retry */
  pending() {
    try {
      const raw = this.storage ? this.storage.getItem(UPLOAD.pendingKey) : null;
      const a = raw ? JSON.parse(raw) : [];
      return Array.isArray(a) ? a.filter((x) => x && typeof x.body === 'string') : [];
    } catch { return []; }
  }

  /** @param {Pending[]} list */
  writePending(list) {
    if (!this.storage) return false;
    try {
      if (!list.length) this.storage.removeItem(UPLOAD.pendingKey);
      else this.storage.setItem(UPLOAD.pendingKey, JSON.stringify(list));
      return true;
    } catch {
      // quota: keep only the newest; else nothing (the record itself is still in the diagnostics)
      try { this.storage.setItem(UPLOAD.pendingKey, JSON.stringify(list.slice(-1))); return true; } catch { /* full */ }
      try { this.storage.removeItem(UPLOAD.pendingKey); } catch { /* blocked */ }
      return false;
    }
  }

  /** @param {Pending} p */
  addPending(p) {
    const list = this.pending();
    list.push(p);
    while (list.length > UPLOAD.maxPending) list.shift();
    return this.writePending(list);
  }

  /**
   * The next page load: send what waits (oldest first); keep what fails again (up to UPLOAD.maxTries each).
   * @returns {Promise<{ sent: number, kept: number }>}
   */
  async retryPending() {
    if (!this.enabled) return { sent: 0, kept: 0 };
    const list = this.pending();
    if (!list.length) return { sent: 0, kept: 0 };
    this.setStatus('sending', `${list.length} waiting upload${list.length === 1 ? '' : 's'}`);
    /** @type {Pending[]} */ const keep = [];
    let sent = 0;
    for (const p of list) {
      const r = await this.post(p.body);
      this.note(`retry ${p.kind}`, r);
      if (r.ok) { sent++; this.retried++; continue; }
      if ((p.tries || 1) + 1 < UPLOAD.maxTries) keep.push({ ...p, tries: (p.tries || 1) + 1 });
    }
    this.writePending(keep);
    if (keep.length) this.setStatus('retry', `${keep.length} waiting (${sent} sent)`);
    else this.setStatus('sent', `${sent} waiting upload${sent === 1 ? '' : 's'} sent`);
    return { sent, kept: keep.length };
  }

  /** @param {string} kind @param {PostResult} r */
  note(kind, r) {
    this.log.push({ kind, ok: r.ok, status: r.status, bytes: r.bytes, keepalive: r.keepalive, ms: r.ms, error: r.error });
    if (this.log.length > 10) this.log.shift();
  }

  /** @param {string} state @param {string} [detail] */
  setStatus(state, detail = '') {
    this.state = state;
    this.detail = detail;
    if (this.onStatus) {
      try { this.onStatus({ state, text: /** @type {any} */ (UPLOAD_TEXT)[state] ?? state, detail }); } catch { /* the page */ }
    }
  }

  /** JSON-safe summary (the page diagnostics). */
  report() {
    return { enabled: this.enabled, state: this.state, sent: this.sent, failed: this.failed, retried: this.retried, pending: this.pending().length, log: this.log.slice() };
  }
}

/** @param {unknown} e */
function errText(e) { return (e && typeof e === 'object' && 'message' in e ? String(/** @type {any} */ (e).message) : String(e)).slice(0, 200); }

/** @param {number} b */
function kb(b) { return `${Math.max(1, Math.round(b / 1024))} KB`; }
