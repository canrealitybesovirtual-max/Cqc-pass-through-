// @ts-check
import * as THREE from 'three';

/**
 * A text panel drawn on a canvas (docs/PLAN.md §10 "Canvas panels"):
 * - redraws only when its text changes and only while visible;
 * - one texture upload per redraw, no mipmaps (three's default would rebuild
 *   them on every upload);
 * - follows the head lazily ("tag-along") with preallocated math.
 */
export class CanvasPanel {
  /** @param {{ width?: number, height?: number, worldWidth?: number }} [o] */
  constructor({ width = 1024, height = 640, worldWidth = 0.56 } = {}) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = /** @type {CanvasRenderingContext2D} */ (this.canvas.getContext('2d'));
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.generateMipmaps = false;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(worldWidth, (worldWidth * height) / width), mat);
    this.mesh.renderOrder = 50;
    this.mesh.frustumCulled = false;
    this.key = '';
    /** @type {string[]} */ this.lines = [];
    this.dirty = false;
    this.uploads = 0;
    this.placed = false;
    this._moving = false;
    // tag-along scratch
    this._fwd = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._look = new THREE.Vector3();
  }

  /** @param {string[]} lines */
  setLines(lines) {
    const key = lines.join('\n');
    if (key === this.key) return;
    this.key = key;
    this.lines = lines;
    this.dirty = true;
  }

  /** Draw + upload if needed. Returns true when an upload was queued. */
  flush() {
    if (!this.dirty || !this.mesh.visible) return false;
    const c = this.ctx, W = this.canvas.width, H = this.canvas.height;
    c.fillStyle = '#10161d';
    c.fillRect(0, 0, W, H);
    c.strokeStyle = '#2f4256';
    c.lineWidth = 4;
    c.strokeRect(2, 2, W - 4, H - 4);
    const n = this.lines.length;
    const lh = Math.min(46, (H - 40) / Math.max(1, n));
    let y = 20 + lh * 0.8;
    for (let i = 0; i < n; i++) {
      const s = this.lines[i];
      const head = i === 0;
      c.font = `${head ? '600 ' : ''}${Math.round(lh * (head ? 0.72 : 0.6))}px system-ui, sans-serif`;
      c.fillStyle = head ? '#ffffff' : s.startsWith('✓') ? '#7ee29b' : s.startsWith('!') ? '#ffc061' : s.startsWith('[') ? '#9fb3c8' : '#dfe7ef';
      fitText(c, s, 24, y, W - 48);
      y += lh;
    }
    this.texture.needsUpdate = true;
    this.dirty = false;
    this.uploads++;
    return true;
  }

  /**
   * Keep the panel about 0.8 m ahead and a little low; it only moves when it
   * drifts out of a comfortable zone, then eases back.
   * @param {THREE.Camera} cam XR camera (world pose)
   * @param {number} dt
   */
  follow(cam, dt) {
    const f = this._fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    f.y = 0;
    if (f.lengthSq() < 1e-6) return;
    f.normalize();
    const t = this._target.copy(cam.position).addScaledVector(f, 0.8);
    t.y = cam.position.y - 0.22;
    const p = this.mesh.position;
    const far = p.distanceToSquared(t) > 0.35 * 0.35;
    if (!this.placed) { p.copy(t); this.placed = true; }
    else if (far || this._moving) {
      this._moving = p.distanceToSquared(t) > 0.02 * 0.02;
      p.lerp(t, 1 - Math.exp(-dt * 5));
    }
    this.mesh.lookAt(this._look.copy(cam.position));
  }
}

/**
 * Shrinks a line horizontally when it is too wide instead of cutting it off.
 * @param {CanvasRenderingContext2D} c
 * @param {string} s
 * @param {number} x
 * @param {number} y
 * @param {number} max
 */
function fitText(c, s, x, y, max) {
  const w = c.measureText(s).width;
  if (w <= max) { c.fillText(s, x, y); return; }
  c.save();
  c.translate(x, y);
  c.scale(max / w, 1);
  c.fillText(s, 0, 0);
  c.restore();
}
