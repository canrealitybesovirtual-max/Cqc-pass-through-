// @ts-check
import * as THREE from 'three';

/**
 * Phase 1 test object: a 20 cm cube placed once, 1.2 m ahead of where you look
 * at session start, then world-locked. If it swims or drifts, tracking or the
 * reference space is wrong. In VR mode a floor grid is added for orientation.
 */
export class TestCube {
  /** @param {THREE.Scene} scene */
  constructor(scene) {
    this.mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.2, 0.2, 0.2),
      new THREE.MeshStandardMaterial({ color: 0xd9822b, roughness: 0.55, metalness: 0.1 }),
    );
    this.mesh.visible = false;
    scene.add(this.mesh);
    this.grid = new THREE.GridHelper(6, 12, 0x5a6b7d, 0x2c3743);
    this.grid.visible = false;
    scene.add(this.grid);
    this.placed = false;
    this._f = new THREE.Vector3();
  }

  /** @param {boolean} vr */
  reset(vr) {
    this.placed = false;
    this.mesh.visible = false;
    this.grid.visible = vr;
  }

  /**
   * @param {THREE.Camera} cam
   * @param {number} dt
   */
  update(cam, dt) {
    if (!this.placed) {
      const f = this._f.set(0, 0, -1).applyQuaternion(cam.quaternion);
      f.y = 0;
      if (f.lengthSq() < 1e-6 || (cam.position.x === 0 && cam.position.y === 0 && cam.position.z === 0)) return;
      f.normalize();
      this.mesh.position.copy(cam.position).addScaledVector(f, 1.2);
      this.mesh.position.y = Math.max(0.3, cam.position.y - 0.25);
      this.mesh.visible = true;
      this.placed = true;
    }
    this.mesh.rotation.y += dt * 0.6;
  }
}
