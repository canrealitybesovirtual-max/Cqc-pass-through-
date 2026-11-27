// @ts-check
import * as THREE from 'three';

/**
 * A text panel drawn on a canvas (docs/PLAN.md §10 "Canvas panels"):
 * - redraws only when its text changes and only while visible;
 * - one texture upload per redraw, no mipmaps (three's default would rebuild
 *   them on every upload);
 * - follows the head lazily ("tag-along") with preallocated math.
 */
/**
 * The tag-along placement shared by the canvas panel (probe sessions) and the
 * glyph panel (play, v0.5: no texture uploads): about 0.8 m ahead and a
 * little low, moving only when it drifts out of a comfortable zone; optional
 * hide-while-walking. Preallocated maths.
 */
export class TagAlong {
  /** @param {THREE.Object3D} mesh */
  constructor(mesh) {
    this.mesh = /** @type {any} */ (mesh);
    /**
     * Turn the panel's spot this far (radians, + = left) from straight ahead, so it
     * never sits between the eyes and what is straight ahead (the probe cube).
     */
    this.yawOffset = 0;
    /**
     * Hide while the head moves faster than 0.35 m/s (walking: the panel must not
     * cover door jambs and furniture); shown again after 0.5 s slower. The caller
     * then shows/hides the panel with `shown`, not `mesh.visible`.
     */
    this.autoHide = false;
    this.shown = true;
    this._speed = 0;
    this._still = 0;
    this._lastX = NaN;
    this._lastZ = NaN;
    this.placed = false;
    this._moving = false;
    // tag-along scratch
    this._fwd = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._look = new THREE.Vector3();
  }

  /** New session: place it afresh in front of the head, shown at once. */
  restart() {
    this.placed = false;
    this._moving = false;
    this._speed = 0;
    this._still = 0.5;
    this._lastX = NaN;
    this._lastZ = NaN;
  }

  /**
   * Keep the panel about 0.8 m ahead and a little low; it only moves when it
   * drifts out of a comfortable zone, then eases back.
   * @param {THREE.Camera} cam XR camera (world pose)
   * @param {number} dt
   */
  follow(cam, dt) {
    if (this.autoHide) this._walkHide(cam, dt);
    const f = this._fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    f.y = 0;
    if (f.lengthSq() < 1e-6) return;
    f.normalize();
    if (this.yawOffset !== 0) f.applyAxisAngle(UP, this.yawOffset);
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

  /**
   * @param {THREE.Camera} cam
   * @param {number} dt
   */
  _walkHide(cam, dt) {
    const x = cam.position.x, z = cam.position.z;
    if (dt > 0 && this._lastX === this._lastX) {
      const v = Math.hypot(x - this._lastX, z - this._lastZ) / dt;
      this._speed += (Math.min(v, 5) - this._speed) * (1 - Math.exp(-dt * 6));
    }
    this._lastX = x;
    this._lastZ = z;
    if (this._speed > 0.35) this._still = 0;
    else this._still += dt;
    const vis = this.shown && this._still >= 0.5;
    if (vis && !this.mesh.visible) this.placed = false; // re-place in front, no slide across the room
    this.mesh.visible = vis;
  }
}

export class CanvasPanel extends TagAlong {
  /** @param {{ width?: number, height?: number, worldWidth?: number }} [o] */
  constructor({ width = 1024, height = 640, worldWidth = 0.56 } = {}) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const texture = new THREE.CanvasTexture(canvas);
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({ map: texture, toneMapped: false });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(worldWidth, (worldWidth * height) / width), mat);
    super(mesh);
    this.canvas = canvas;
    this.ctx = /** @type {CanvasRenderingContext2D} */ (this.canvas.getContext('2d'));
    this.texture = texture;
    this.mesh.renderOrder = 50;
    this.mesh.frustumCulled = false;
    this.key = '';
    /** @type {string[]} */ this.lines = [];
    this.dirty = false;
    this.uploads = 0;
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
}

const UP = new THREE.Vector3(0, 1, 0);

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
