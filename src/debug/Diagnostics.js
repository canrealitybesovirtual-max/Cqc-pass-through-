// @ts-check
/**
 * Everything the headset measured, kept across reloads in localStorage and
 * exported as one JSON (copy, download, or share). Writes happen only at
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
    if (this.data.pageErrors.length < 50) this.data.pageErrors.push(`${new Date().toISOString()} ${msg}`);
  }

  save() {
    try { localStorage.setItem(KEY, JSON.stringify({ sessions: this.data.sessions })); } catch { /* quota or blocked */ }
  }

  clear() {
    this.data.sessions = [];
    this.data.pageErrors = [];
    try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  }

  json() { return JSON.stringify({ ...this.data, exportedAt: new Date().toISOString() }, null, 1); }

  fileName() { return `cqc-pt-diagnostics-${this.data.version}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`; }

  /** @returns {Promise<string>} what happened, for the page */
  async copy() {
    const text = this.json();
    try {
      await navigator.clipboard.writeText(text);
      return `Copied ${Math.round(text.length / 1024)} KB — paste it into the chat.`;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok ? `Copied ${Math.round(text.length / 1024)} KB — paste it into the chat.` : 'Copy blocked by the browser — use Download or Share.';
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
    return 'Download started.';
  }

  /** @returns {Promise<string>} */
  async share() {
    const text = this.json();
    try {
      const file = new File([text], this.fileName(), { type: 'application/json' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'CQC Pass-Through diagnostics' }); return 'Shared.'; }
      if (navigator.share) { await navigator.share({ title: 'CQC Pass-Through diagnostics', text }); return 'Shared as text.'; }
    } catch (e) { return `Share cancelled or failed (${e}).`; }
    return 'Sharing is not available here — use Copy or Download.';
  }
}
