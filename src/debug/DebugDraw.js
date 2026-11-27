// @ts-check
import * as THREE from 'three';

/**
 * Debug visuals: two controller rays and one hit-test reticle. Poses arrive as
 * XR column-major Float32Array matrices and are copied in with `fromArray`
 * (no allocation, matrixAutoUpdate off).
 */
export class DebugDraw {
  /** @param {THREE.Scene} scene */
  constructor(scene) {
    const rayGeo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, -3], 3));
    this.rayIdle = new THREE.LineBasicMaterial({ color: 0x8fa3b8 });
    this.rayHot = new THREE.LineBasicMaterial({ color: 0xffb02e });
    /** @type {THREE.Line[]} */
    this.rays = [0, 1].map(() => {
      const l = new THREE.Line(rayGeo, this.rayIdle);
      l.matrixAutoUpdate = false;
      l.frustumCulled = false;
      l.visible = false;
      scene.add(l);
      return l;
    });

    const ringGeo = new THREE.RingGeometry(0.025, 0.04, 32).rotateX(-Math.PI / 2); // lies flat in the hit pose (y = surface normal)
    this.reticle = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0x48e07a, depthTest: false }));
    this.reticle.renderOrder = 40;
    this.reticle.matrixAutoUpdate = false;
    this.reticle.frustumCulled = false;
    this.reticle.visible = false;
    scene.add(this.reticle);
  }

  /**
   * @param {number} i
   * @param {Float32Array} m
   * @param {boolean} hot
   */
  setRay(i, m, hot) {
    const r = this.rays[i];
    r.matrix.fromArray(m);
    r.matrixWorldNeedsUpdate = true;
    r.material = hot ? this.rayHot : this.rayIdle;
    r.visible = true;
  }

  /** @param {number} i */
  hideRay(i) { this.rays[i].visible = false; }

  /** @param {Float32Array} m */
  setReticle(m) {
    this.reticle.matrix.fromArray(m);
    this.reticle.matrixWorldNeedsUpdate = true;
    this.reticle.visible = true;
  }

  hideReticle() { this.reticle.visible = false; }

  hideAll() { this.rays[0].visible = this.rays[1].visible = this.reticle.visible = false; }
}
