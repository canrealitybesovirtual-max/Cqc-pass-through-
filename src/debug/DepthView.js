// @ts-check
import * as THREE from 'three';
import { linearParams } from '../xr/occlusionMath.js';

/**
 * Probe aid: a world-locked picture of what the depth sensor sees (the left
 * eye's layer of three's depth texture), as a colour ramp by distance:
 * red 0.3 m → yellow 1 m → green 2 m → blue 4 m and beyond; black = raw 0
 * (no data, or a texture the shader cannot read). If your hand shows up in
 * the picture but does not hide the cube, the occlusion pass is at fault; if
 * it never shows up, the depth data has no hand in it.
 *
 * The material is created at load (App constructor, before the warm-up), so
 * its program is compiled by the warm-up draw with three's empty array
 * texture bound; showing it later only changes a uniform and `visible`.
 */
const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
	vUv = uv;
	gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`;

const FRAG = /* glsl */ `
uniform sampler2DArray depthTex;
uniform vec2 lin;   // metres = lin.x / ( lin.y - raw )
varying vec2 vUv;
vec3 ramp( float m ) {
	if ( m < 1.0 ) return mix( vec3( 1.0, 0.1, 0.05 ), vec3( 1.0, 0.85, 0.1 ), clamp( ( m - 0.3 ) / 0.7, 0.0, 1.0 ) );
	if ( m < 2.0 ) return mix( vec3( 1.0, 0.85, 0.1 ), vec3( 0.2, 0.9, 0.3 ), m - 1.0 );
	return mix( vec3( 0.2, 0.9, 0.3 ), vec3( 0.15, 0.35, 1.0 ), clamp( ( m - 2.0 ) / 2.0, 0.0, 1.0 ) );
}
void main() {
	float raw = texture( depthTex, vec3( vUv, 0.0 ) ).r;
	vec3 c = raw <= 0.0 ? vec3( 0.0 ) : ramp( lin.x / max( lin.y - raw, 1e-6 ) );
	gl_FragColor = vec4( c, 1.0 );
}`;

export class DepthView {
  /** @param {THREE.Scene} scene */
  constructor(scene) {
    this.material = new THREE.ShaderMaterial({
      name: 'probe-depth-view',
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { depthTex: { value: null }, lin: { value: new THREE.Vector2(0.1, 1) } },
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.32, 0.32), this.material);
    this.mesh.name = 'probe-depth-view';
    this.mesh.renderOrder = 45;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    scene.add(this.mesh);
    this.on = false;
    this._f = new THREE.Vector3();
    this._lin = { a: 0.1, b: 1 };
  }

  /**
   * Show or hide; placed once when shown: 0.9 m ahead, 25° to the right, at eye height − 0.15 m.
   * @param {boolean} on
   * @param {THREE.Camera} cam XR camera (world pose)
   */
  toggle(on, cam) {
    this.on = on;
    if (!on) { this.mesh.visible = false; return; }
    const f = this._f.set(0, 0, -1).applyQuaternion(cam.quaternion);
    f.y = 0;
    if (f.lengthSq() < 1e-6) f.set(0, 0, -1);
    f.normalize().applyAxisAngle(THREE.Object3D.DEFAULT_UP, -0.44);
    this.mesh.position.copy(cam.position).addScaledVector(f, 0.9);
    this.mesh.position.y = cam.position.y - 0.15;
    this.mesh.lookAt(cam.position.x, this.mesh.position.y, cam.position.z);
  }

  /**
   * Every frame while shown: three's depth texture and the near/far it uses.
   * @param {any} renderer
   * @param {number} near @param {number} far
   */
  update(renderer, near, far) {
    if (!this.on) return;
    const tex = renderer.xr.isPresenting ? renderer.xr.getDepthTexture() : null;
    this.material.uniforms.depthTex.value = tex;
    if (Number.isFinite(near) && near > 0) {
      linearParams(near, far, this._lin);
      this.material.uniforms.lin.value.set(this._lin.a, this._lin.b);
    }
    this.mesh.visible = tex !== null;
  }
}
