// @ts-check
/**
 * Everything the headset measured, kept across reloads in localStorage and
 * exported as JSON: Copy takes only the last session (small enough to paste
 * into a chat), Download and Share take everything. Writes happen only at
 * session end or when the page is hidden, never from the frame loop.
 */

const KEY = 'cqcpt.diag.v1';
const MAX_SESSIONS = 12;

export class Diagnostics {
  /** @param {{ version: string }} o */
  constructor({ version }) {
    /** @type {{ app: string, version: string, ua: string, support: any, sessions: any[], pageErrors: string[] }} */
    this.data = { app: 'cqc-pass-through', version, ua: navigator.userAgent, support: null, sessions: [], pageErrors: [] };
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const old = JSON.parse(raw);
        if (old && Array.isArray(old.sessions)) this.data.sessions = old.sessions.slice(-MAX_SESSIONS);
        if (old && Array.isArray(old.pageErrors)) this.data.pageErrors = old.pageErrors.slice(-50);
      }
    } catch { /* storage blocked or corrupt: start fresh */ }
  }

  /** @param {any} rec */
  addSession(rec) {
    this.data.sessions.push(rec);
    if (this.data.sessions.length > MAX_SESSIONS) this.data.sessions.shift();
    this.save();
  }

  /** @param {string} msg */
  pageError(msg) {
    const E = this.data.pageErrors;
    E.push(`${new Date().toISOString()} ${this.data.version} ${msg}`);
    if (E.length > 50) E.shift(); // keep the latest (older builds' errors drop out first)
  }

  save() {
    try { localStorage.setItem(KEY, JSON.stringify({ sessions: this.data.sessions, pageErrors: this.data.pageErrors })); } catch { /* quota or blocked */ }
  }

  clear() {
    this.data.sessions = [];
    this.data.pageErrors = [];
    try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  }

  /** Everything (Download and Share): every kept session, hitch logs and snapshots. */
  json() { return JSON.stringify({ ...this.data, exportedAt: new Date().toISOString() }, null, 1); }

  /**
   * What Copy pastes into the chat: the LAST session only, plus everything
   * that is not a session (app, version, ua, support, preload, pageErrors).
   * Compact (no indentation) so it stays small.
   */
  lastJson() {
    const { sessions, ...rest } = this.data;
    const last = sessions.length ? [sessions[sessions.length - 1]] : [];
    return JSON.stringify({ ...rest, sessions: last, sessionsKept: sessions.length,
      copied: 'last session only (Download or Share has every kept session)', exportedAt: new Date().toISOString() });
  }

  /** Sizes of both exports, for the page: { copy: '42 KB', all: '310 KB', sessions: 6 }. Allocates (page only). */
  sizes() {
    return { copy: sizeText(this.lastJson().length), all: sizeText(this.json().length), sessions: this.data.sessions.length };
  }

  fileName() { return `cqc-pt-diagnostics-${this.data.version}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`; }

  /** @returns {Promise<string>} what happened, for the page */
  async copy() {
    const text = this.lastJson();
    const size = sizeText(text.length);
    const what = this.data.sessions.length ? 'the last session' : 'the page diagnostics (no session yet)';
    try {
      await navigator.clipboard.writeText(text);
      return `Copied ${what} (${size}) — paste it into the chat.`;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok ? `Copied ${what} (${size}) — paste it into the chat.` : `Copy blocked by the browser (${size}) — use Download or Share.`;
    }
  }

  download() {
    const url = URL.createObjectURL(new Blob([this.json()], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = this.fileName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return `Download started (${this.allText()}).`;
  }

  /** @returns {Promise<string>} */
  async share() {
    const text = this.json();
    try {
      const file = new File([text], this.fileName(), { type: 'application/json' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'CQC Pass-Through diagnostics' }); return `Shared (${this.allText(text)}).`; }
      if (navigator.share) { await navigator.share({ title: 'CQC Pass-Through diagnostics', text }); return `Shared as text (${this.allText(text)}).`; }
    } catch (e) { return `Share cancelled or failed (${e}).`; }
    return 'Sharing is not available here — use Copy or Download.';
  }

  /** "310 KB, 6 sessions" for the full export. @param {string} [text] the full export, when already made */
  allText(text) {
    const n = this.data.sessions.length;
    return `${sizeText((text ?? this.json()).length)}, ${n} session${n === 1 ? '' : 's'}`;
  }
}

/** @param {number} chars JSON length (ASCII, so ≈ bytes) */
export function sizeText(chars) {
  return chars >= 1024 * 1024 ? `${(chars / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(chars / 1024))} KB`;
}
