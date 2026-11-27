// @ts-check
/**
 * The 2D page shown before and after XR: enter buttons, the reduced-features
 * retry, and the diagnostics summary with copy / download / share.
 */

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

export class HomePage {
  /** @param {string} version */
  constructor(version) {
    $('ver').textContent = version;
    this.msg = $('msg');
    this.support = $('support');
    /** @type {import('../app/App.js').App|null} */ this.app = null;
    /** @type {import('../debug/Diagnostics.js').Diagnostics|null} */ this.diag = null;
  }

  /** @param {string} text */
  note(text) { this.msg.textContent = text; }

  /** @param {string} text */
  unsupported(text) { this.support.textContent = text; this.support.className = 'bad'; }

  /**
   * @param {import('../app/App.js').App} app
   * @param {import('../debug/Diagnostics.js').Diagnostics} diag
   * @param {any} sup
   */
  bind(app, diag, sup) {
    this.app = app;
    this.diag = diag;
    const ar = !!sup.ar, vr = !!sup.vr;
    if (!sup.secureContext) this.unsupported('This page needs HTTPS for WebXR.');
    else if (!sup.webxr) this.unsupported('WebXR is not available here. Open this page in the Meta Quest Browser.');
    else if (!ar) this.unsupported(`Mixed reality (immersive-ar) is not supported here.${vr ? ' VR test only.' : ''}`);
    else { this.support.textContent = 'Mixed reality is supported.'; this.support.className = 'ok'; }

    /** @type {[string, string, boolean][]} */
    const buttons = [['bPlay', 'play', ar], ['bProbe', 'probe', ar], ['bBounds', 'bounds', ar], ['bVR', 'vr', vr], ['bRetry', 'reduced', ar]];
    for (const [id, mode, ok] of buttons) {
      const b = /** @type {HTMLButtonElement} */ ($(id));
      b.disabled = !ok;
      // No await, no work before enter(): the click is the user gesture requestSession needs.
      b.addEventListener('click', () => app.enter(mode));
    }
    $('bCopy').addEventListener('click', async () => this.note(await diag.copy()));
    $('bDownload').addEventListener('click', () => this.note(diag.download()));
    $('bShare').addEventListener('click', async () => this.note(await diag.share()));
    $('bClear').addEventListener('click', () => { diag.clear(); this.renderSummary(); this.note('Diagnostics cleared.'); });
    this.renderSummary();
  }

  /** @param {string} mode */
  entering(mode) { this.note(`Starting ${mode}…`); this.setButtons(false); }

  /** @param {string} mode */
  inXR(mode) { this.note(`In ${mode}. Hold both grips for 1 s to exit.`); }

  /**
   * @param {string} mode
   * @param {unknown} e
   * @param {boolean} offerRetry
   */
  failed(mode, e, offerRetry) {
    this.setButtons(true);
    $('bRetry').hidden = !offerRetry;
    this.note(`${mode} did not start: ${e && typeof e === 'object' && 'message' in e ? /** @type {any} */ (e).message : e}${offerRetry ? ' — tap "Tap again (reduced features)".' : ''}`);
    this.renderSummary();
  }

  /** @param {any} rec */
  ended(rec) {
    this.setButtons(true);
    $('bRetry').hidden = true;
    this.note(rec ? `${rec.mode} ended. Results are below — tap Copy and paste them into the chat.` : 'Session ended.');
    this.renderSummary();
  }

  /** @param {boolean} on */
  setButtons(on) {
    const sup = (this.diag && this.diag.data.support) || {};
    /** @type {[string, boolean][]} */
    const gate = [['bPlay', !!sup.ar], ['bProbe', !!sup.ar], ['bBounds', !!sup.ar], ['bVR', !!sup.vr], ['bRetry', !!sup.ar]];
    for (const [id, ok] of gate) /** @type {HTMLButtonElement} */ ($(id)).disabled = !on || !ok;
  }

  renderSummary() {
    const box = $('summary');
    const sessions = this.diag ? this.diag.data.sessions : [];
    if (!sessions.length) { box.textContent = 'No sessions recorded yet.'; return; }
    const rows = sessions.slice(-6).reverse().map((r) => {
      const P = r.probes || {}, g = r.granted || {};
      const bits = [];
      if (r.errors && r.errors.length) bits.push(`errors: ${r.errors.length}`);
      if (g.referenceSpace) bits.push(`space ${g.referenceSpace}`);
      if (g.supportedFrameRates) bits.push(`rates ${g.supportedFrameRates.join('/')}`);
      if (P.anchor) bits.push(`anchor ${P.anchor.state}`);
      if (P.hitTest && P.hitTest.buckets) { const b = P.hitTest.buckets; bits.push(`hit in ${b.inside.hits}/${b.inside.samples} out ${b.outside.hits}/${b.outside.samples}`); }
      if (P.bounds) bits.push(`bounds ${P.bounds.maxPoints ?? P.bounds.space} pts`);
      for (const run of r.perfRuns || []) bits.push(run.incomplete ? `run ${run.label} incomplete` : `run ${run.label} ${run.pass ? 'PASS' : 'FAIL'} (CPU p99 ${run.cpu.p99} ms, missed ${run.missedPct}%)`);
      return `<li><b>${esc(r.mode)}</b> ${esc((r.startedAt || '').slice(11, 19))} — ${esc(bits.join(' · '))}</li>`;
    });
    box.innerHTML = `<ul>${rows.join('')}</ul>`;
  }
}

/** @param {string} s */
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => /** @type {any} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }
