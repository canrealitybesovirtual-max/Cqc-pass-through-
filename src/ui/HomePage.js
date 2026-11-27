// @ts-check
/**
 * The 2D page shown before and after XR: the preload bar ("Loading 63%"), enter
 * buttons (gated on the preload), the reduced-features retry, and the
 * diagnostics summary with copy / download / share.
 */

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

export class HomePage {
  /** @param {string} version */
  constructor(version) {
    $('ver').textContent = version;
    this.msg = $('msg');
    this.support = $('support');
    this.loadBox = $('load');
    this.loadBar = /** @type {HTMLProgressElement} */ ($('loadBar'));
    this.loadText = $('loadText');
    /** @type {import('../app/App.js').App|null} */ this.app = null;
    /** @type {import('../debug/Diagnostics.js').Diagnostics|null} */ this.diag = null;
    /** @type {any} */ this.sup = {};
    /**
     * Preload state (src/core/Preload.js). Every session button waits while
     * loading (the warm-up draw must finish before XR); Enter MR needs 'ready'.
     * @type {'idle'|'loading'|'ready'|'failed'}
     */
    this.load = 'idle';
    this.pct = -1;
    /**
     * Called synchronously inside the button's click, right after app.enter(mode)
     * (for work that needs the user gesture, like unlocking audio).
     * @type {((mode: string) => void)|null}
     */
    this.onEnter = null;
    /**
     * Called after the Copy button copied (v0.4: the automatic upload sends the same last session).
     * @type {(() => void)|null}
     */
    this.onCopy = null;
    /** The automatic upload's status line (v0.4). */
    this.uploadEl = document.getElementById('upload');
  }

  /**
   * The automatic diagnostics upload's state: "Sent ✓", "Will retry", "Sending…" (with what), or off.
   * @param {{ state: string, text: string, detail: string }} s
   */
  uploadStatus(s) {
    const el = this.uploadEl;
    if (!el) return;
    el.textContent = s.text ? `Diagnostics upload: ${s.text}${s.detail ? ` (${s.detail})` : ''}` : '';
    el.className = s.state === 'sent' ? 'ok' : s.state === 'retry' ? 'bad' : 'quiet';
    el.dataset.state = s.state;
  }

  /**
   * Progress of the preload: "Loading 63%". Touches the DOM only when the whole
   * percent changes; reaches 100 % only at the very end.
   * @param {number} fraction 0..1
   * @param {string} [label]
   */
  loading(fraction, label = '') {
    if (this.load === 'ready' || this.load === 'failed') return; // a late callback after the end
    const first = this.load !== 'loading';
    this.load = 'loading';
    this.loadBox.hidden = false;
    const pct = Math.max(0, Math.min(100, Math.floor(fraction * 100)));
    if (first) this.setButtons(true);
    if (pct === this.pct) return;
    this.pct = pct;
    this.loadBar.value = pct / 100;
    this.loadText.textContent = `Loading ${pct}%`;
    this.loadText.title = label;
    this.loadText.className = '';
  }

  /**
   * Everything is loaded and warmed: Enter MR becomes available.
   * @param {{ times: { totalMs: number }, warnings: string[] }} p
   */
  loaded(p) {
    this.load = 'ready';
    this.loadBar.value = 1;
    const warn = p.warnings.length ? ` · ${p.warnings[0]}` : '';
    this.loadText.textContent = `Ready (loaded in ${(p.times.totalMs / 1000).toFixed(1)} s)${warn}`;
    this.loadText.className = p.warnings.length ? 'bad' : 'ok';
    this.setButtons(true);
  }

  /**
   * The preload failed: say why; the probe sessions stay usable.
   * @param {string} error
   */
  loadFailed(error) {
    this.load = 'failed';
    this.loadBox.hidden = false;
    this.loadText.textContent = `Loading failed: ${error}. Enter MR needs the game files; the probe sessions still work. Reload the page to try again.`;
    this.loadText.className = 'bad';
    this.setButtons(true);
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
    this.sup = sup || {};
    const ar = !!sup.ar, vr = !!sup.vr;
    if (!sup.secureContext) this.unsupported('This page needs HTTPS for WebXR.');
    else if (!sup.webxr) this.unsupported('WebXR is not available here. Open this page in the Meta Quest Browser.');
    else if (!ar) this.unsupported(`Mixed reality (immersive-ar) is not supported here.${vr ? ' VR test only.' : ''}`);
    else { this.support.textContent = 'Mixed reality is supported.'; this.support.className = 'ok'; }

    /** @type {[string, string][]} */
    const buttons = [['bPlay', 'play'], ['bSpot', 'spot'], ['bProbe', 'probe'], ['bBounds', 'bounds'], ['bVR', 'vr'], ['bRetry', 'reduced']];
    for (const [id, mode] of buttons) {
      // No await, no work before enter(): the click is the user gesture requestSession needs.
      $(id).addEventListener('click', () => {
        app.enter(mode);
        if (this.onEnter) this.onEnter(mode);
      });
    }
    this.setButtons(true);
    $('bCopy').addEventListener('click', async () => {
      if (this.onCopy) this.onCopy(); // the upload starts first (the clipboard may wait for a permission)
      this.note(await diag.copy());
    });
    $('bDownload').addEventListener('click', () => this.note(diag.download()));
    $('bShare').addEventListener('click', async () => this.note(await diag.share()));
    $('bClear').addEventListener('click', () => { diag.clear(); this.renderSummary(); this.note('Diagnostics cleared.'); });
    this.renderSummary();
  }

  /** @param {string} mode */
  entering(mode) { this.note(`Starting ${mode}…`); this.setButtons(false); }

  /**
   * @param {string} mode
   * @param {boolean} [game] the session runs the game (exit with Y, not the grips)
   * @param {string|null} [spaceNote] the honest boundary line when Roam has no whole-house tracking (page only)
   * @param {string} [style] 'roam' | 'spot'
   */
  inXR(mode, game = false, spaceNote = null, style = 'roam') {
    const menu = 'Menu and pause: look at your watch and touch it with the right controller (or point and pull the trigger). Exit: watch → EXIT, or hold Y for 2 s.';
    const start = style === 'spot' ? 'Stand in an open spot and pull the trigger to start.' : 'Pull the trigger to start, then walk anywhere you scanned in Space Setup (walk, don’t run).';
    this.note(game ? `In ${mode}. ${start} ${menu}${spaceNote ? ` ${spaceNote}.` : ''}` : `In ${mode}. Hold both grips for 1 s to exit.`);
  }

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
    const sup = this.sup || {};
    const ready = this.load === 'ready', idle = this.load !== 'loading';
    /** @type {[string, boolean][]} */
    const gate = [['bPlay', !!sup.ar && ready], ['bSpot', !!sup.ar && ready], ['bProbe', !!sup.ar && idle], ['bBounds', !!sup.ar && idle], ['bVR', !!sup.vr && idle], ['bRetry', !!sup.ar && ready]];
    for (const [id, ok] of gate) { const b = /** @type {HTMLButtonElement|null} */ (document.getElementById(id)); if (b) b.disabled = !on || !ok; }
  }

  renderSummary() {
    const box = $('summary');
    const sessions = this.diag ? this.diag.data.sessions : [];
    const size = $('diagSize');
    if (size && this.diag) {
      const z = this.diag.sizes();
      size.textContent = z.sessions ? `Copy: the last session (${z.copy}). Download / Share: all ${z.sessions} kept sessions (${z.all}).` : '';
    }
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
      const D = P.liveDepth;
      if (D && D.granted) bits.push(D.active ? `depth ${D.valid ? `${D.width}×${D.height}, ${D.textureChanges ? 'new texture per frame' : 'one texture'}` : 'no valid frames'}` : `depth off (${D.why})`);
      const G = r.play;
      if (G && G.world) bits.push(`${G.mode ? `${G.mode}: ` : ''}${G.world.describe}; wave ${G.wave ?? 0}, ${G.kills ?? 0} kills`);
      if (G && G.roam && G.roam.spaceNote) bits.push(G.roam.spaceNote);
      const F = P.frameRate;
      if (F && F.target) bits.push(`${F.target} Hz requested: ${F.request}${F.hzAtEnd ? `, ${F.hzAtEnd} Hz measured` : ''}`);
      if (r.audio) bits.push(`audio ${r.audio.atStart} → ${r.audio.at1s ?? '?'}`);
      for (const run of r.perfRuns || []) bits.push(run.incomplete ? `run ${run.label} incomplete` : `run ${run.label} ${run.pass ? 'PASS' : 'FAIL'} (CPU p99 ${run.cpu.p99} ms, missed ${run.missedPct}%)`);
      return `<li><b>${esc(r.mode)}</b> ${esc((r.startedAt || '').slice(11, 19))} — ${esc(bits.join(' · '))}</li>`;
    });
    box.innerHTML = `<ul>${rows.join('')}</ul>`;
  }
}

/** @param {string} s */
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => /** @type {any} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }
