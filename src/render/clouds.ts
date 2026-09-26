import * as THREE from 'three';
import { R_PLANET } from '../core/constants';
import { atmUniforms } from './atmosphere';
import { ATMOS_FUNCS_GLSL, ATMOS_UNIFORMS_GLSL, NOISE_GLSL } from './shaders/common.glsl';
import { altitude } from '../core/geo';

const CLOUD_ALT = 2400;

/**
 * The cloud deck seen from above: a spherical shell at the cloud altitude using the same world-anchored
 * pattern as the sky shader's under-view, so climbing through the layer is continuous. Also casts soft
 * cloud shadows onto the sea/land below via `shadowAt` in shaders that opt in (not required).
 */
export class CloudShell {
  mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  constructor() {
    // a cap is enough: the camera is always within a few hundred km of the origin
    const g = new THREE.SphereGeometry(R_PLANET + CLOUD_ALT, 256, 96, 0, Math.PI * 2, 0, 0.62);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { ...atmUniforms },
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        varying vec3 vW;
        void main(){
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vW = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        ${ATMOS_UNIFORMS_GLSL}
        ${NOISE_GLSL}
        ${ATMOS_FUNCS_GLSL}
        varying vec3 vW;
        void main(){
          #include <logdepthbuf_fragment>
          vec2 uv = vW.xz / 5200.0 + vec2(uAtmTime * 0.0012, uAtmTime * 0.0004);
          float n = fbm(uv) * 0.65 + fbm(uv * 3.7 + 4.0) * 0.35;
          float cov = mix(0.72, 0.36, uCloudCover);
          float dens = smoothstep(cov, cov + 0.22, n);
          if (dens < 0.01) discard;
          vec3 up = atmUp(vW);
          // light from above: bright tops, darker thin edges; shade toward the anti-sun side
          vec2 sunOff = vec2(uSunDir.x, uSunDir.z) * 0.06;
          float n2 = fbm(uv + sunOff) * 0.65 + fbm((uv + sunOff) * 3.7 + 4.0) * 0.35;
          float shade = clamp(1.0 - (n2 - n) * 4.0, 0.45, 1.2);
          float sunUp = clamp(dot(uSunDir, up), 0.0, 1.0);
          vec3 col = uSunColor * 0.09 * shade * (0.35 + 0.65 * sunUp) + uSkyZenith * 0.5;
          col = mix(col, vec3(0.02, 0.025, 0.04), uNight * 0.9);
          col = applyAtmosphere(col, vW);
          float a = smoothstep(0.0, 0.8, dens) * 0.92;
          gl_FragColor = vec4(col * a, a);
        }`,
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.visible = false;
  }

  private _u = new THREE.Vector3();
  private _c = new THREE.Vector3(0, R_PLANET, 0);
  private _y = new THREE.Vector3(0, 1, 0);
  private _q = new THREE.Quaternion();
  private _m = new THREE.Matrix4();
  update(camera: THREE.Camera, cloudCover: number) {
    // only needed when looking down on the deck (from below, the sky shader draws the clouds)
    this.mesh.visible = cloudCover > 0.01 && altitude(camera.position) > CLOUD_ALT + 50;
    // keep the cap centred under the camera (rotate the pole about the planet centre)
    const up = this._u.copy(camera.position).add(this._c).normalize();
    this._q.setFromUnitVectors(this._y, up);
    this.mesh.matrixAutoUpdate = false;
    this.mesh.matrix.makeTranslation(0, -R_PLANET, 0).multiply(this._m.makeRotationFromQuaternion(this._q));
    this.mesh.matrixWorldNeedsUpdate = true;
  }
}
