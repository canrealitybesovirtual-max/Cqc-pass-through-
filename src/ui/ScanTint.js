// @ts-check
import * as THREE from 'three';

/**
 * The walkthrough scan's only cue in the view (v0.5): a faint, soft-edged
 * disc of light blue on the floor under the player (the user's "a light
 * progress cue: a floor tint under the user"). Nothing else is drawn while
 * scanning; the watch shows the rooms found. Made at load (its radial
 * gradient is a static texture uploaded by the warm-up), shown only during
 * the scan; position and opacity are its only per-frame changes.
 */
export class ScanTint {
  constructor() {
    const S = 128, cv = document.createElement('canvas');
    cv.width = S; cv.height = S;
    const c = cv.getContext('2d');
    try {
      if (c) {
        const g = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
        g.addColorStop(0, 'rgba(255,255,255,0.9)');
        g.addColorStop(0.55, 'rgba(255,255,255,0.55)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        c.fillStyle = g;
        c.fillRect(0, 0, S, S);
      }
    } catch { /* a fake canvas (Node tests) */ }
    this.texture = new THREE.CanvasTexture(cv);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.generateMipmaps = false;
    this.texture.minFilter = THREE.LinearFilter;
    this.material = new THREE.MeshBasicMaterial({ map: this.texture, color: 0x7fd6ff, transparent: true, opacity: 0.2, depthWrite: false, toneMapped: false });
    this.material.name = 'scan-tint';
    const geo = new THREE.CircleGeometry(0.55, 48);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'scan-tint';
    this.mesh.renderOrder = 4;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.t = 0;
  }

  /** @param {boolean} on */
  show(on) { this.mesh.visible = on; }

  /**
   * Follow the head on the floor; a slow breath so it reads as "scanning".
   * @param {number} x @param {number} floorY @param {number} z @param {number} dt
   */
  update(x, floorY, z, dt) {
    if (!this.mesh.visible) return;
    this.t += dt;
    this.mesh.position.set(x, floorY + 0.008, z);
    this.material.opacity = 0.16 + 0.06 * Math.sin(this.t * 2.2);
  }
}
