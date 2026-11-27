// @ts-check
import * as THREE from 'three';

/**
 * The Glock's holster shell (research-fit B): a moulded-kydex look from three
 * boxes in Glock gun space, merged into ONE non-indexed geometry (one draw,
 * 36 triangles). It stays at the holster socket's gun-root pose every frame,
 * also with the gun drawn (an empty holster at the hip), so the holstered
 * pistol reads as holstered and not as a gun floating by the thigh.
 *
 * - sleeve over the slide and barrel: x ±0.0195, y −0.030…0.0175, z −0.126…0.032
 * - trigger-guard lobe: x ±0.018, y −0.072…−0.030, z −0.058…0.016
 * - body paddle (inside, toward the hip): x −0.0305…−0.0195, y −0.065…0.010, z −0.045…0.025
 *
 * Material: a matte dark polymer (MeshStandardMaterial 0x16171a, roughness
 * 0.75, metalness 0), built at load and drawn in the warm-up.
 */
export const HOLSTER_BOXES = Object.freeze([
  Object.freeze({ name: 'sleeve', x: [-0.0195, 0.0195], y: [-0.030, 0.0175], z: [-0.126, 0.032] }),
  Object.freeze({ name: 'guard', x: [-0.0180, 0.0180], y: [-0.072, -0.030], z: [-0.058, 0.016] }),
  Object.freeze({ name: 'paddle', x: [-0.0305, -0.0195], y: [-0.065, 0.010], z: [-0.045, 0.025] }),
]);

/** @returns {THREE.Mesh} */
export function makeHolsterShell() {
  const pos = [], nrm = [];
  for (const b of HOLSTER_BOXES) {
    const g = new THREE.BoxGeometry(b.x[1] - b.x[0], b.y[1] - b.y[0], b.z[1] - b.z[0]).toNonIndexed();
    g.translate((b.x[0] + b.x[1]) / 2, (b.y[0] + b.y[1]) / 2, (b.z[0] + b.z[1]) / 2);
    pos.push(...g.attributes.position.array);
    nrm.push(...g.attributes.normal.array);
    g.dispose();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.computeBoundingSphere();
  const mat = new THREE.MeshStandardMaterial({ color: 0x16171a, roughness: 0.75, metalness: 0, envMapIntensity: 0.6 });
  mat.name = 'holster';
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'w2-holster';
  mesh.renderOrder = 10;
  mesh.matrixAutoUpdate = true;
  return mesh;
}
