import * as THREE from 'three';
import { R_PLANET } from '../core/constants';
import { ATMOS_FUNCS_GLSL, ATMOS_UNIFORMS_GLSL, NOISE_GLSL } from './shaders/common.glsl';

/** Uniform objects shared (by reference) with every material in the scene. */
export const atmUniforms = {
  uSunDir: { value: new THREE.Vector3(0.3, 0.5, -0.8).normalize() },
  uSunColor: { value: new THREE.Vector3(10, 9.5, 9) },
  uSkyZenith: { value: new THREE.Vector3(0.18, 0.36, 0.72) },
  uSkyHorizon: { value: new THREE.Vector3(0.62, 0.72, 0.84) },
  uSkyGround: { value: new THREE.Vector3(0.1, 0.13, 0.17) },
  uMoonDir: { value: new THREE.Vector3(-0.3, 0.5, 0.8).normalize() },
  uNight: { value: 0 },
  uHazeDensity: { value: 2.5e-5 },
  uHazeHeight: { value: 1600 },
  uCloudCover: { value: 0.45 },
  uAtmTime: { value: 0 },
  uCamPosW: { value: new THREE.Vector3() },
  uPlanetR: { value: R_PLANET },
};

let installed = false;
/**
 * Replace three's fog chunks with our aerial-perspective model and inject the shared
 * atmosphere uniforms into every built-in material.
 */
export function installAtmosphereChunks() {
  if (installed) return;
  installed = true;
  const C = THREE.ShaderChunk as any;
  C.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying vec3 vFogWorldPos;
#endif`;
  C.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  {
    vec4 fogWP = vec4( transformed, 1.0 );
    #ifdef USE_BATCHING
      fogWP = batchingMatrix * fogWP;
    #endif
    #ifdef USE_INSTANCING
      fogWP = instanceMatrix * fogWP;
    #endif
    vFogWorldPos = ( modelMatrix * fogWP ).xyz;
  }
#endif`;
  C.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  varying vec3 vFogWorldPos;
  ${ATMOS_UNIFORMS_GLSL}
  ${ATMOS_FUNCS_GLSL}
#endif`;
  C.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  gl_FragColor.rgb = applyAtmosphere( gl_FragColor.rgb, vFogWorldPos );
#endif`;
  const proto = THREE.Material.prototype as any;
  proto.onBeforeCompile = function (shader: any) {
    Object.assign(shader.uniforms, atmUniforms);
  };
}

export interface AtmosphereState {
  /** Hours 0..24 */
  timeOfDay: number;
  /** Sun azimuth offset (radians, bearing of sunrise-ish). */
  sunAzimuth: number;
  /** Visibility (m) at sea level. */
  visibility: number;
  cloudCover: number;
}

const lerp3 = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * t);
function gradient(stops: [number, number[]][], x: number) {
  if (x <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i][0]) {
      const t = (x - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]);
      return lerp3(stops[i - 1][1], stops[i][1], t);
    }
  }
  return stops[stops.length - 1][1];
}

// Colors keyed on sun elevation in degrees.
const ZENITH: [number, number[]][] = [
  [-18, [0.0025, 0.004, 0.011]],
  [-8, [0.008, 0.014, 0.04]],
  [-2, [0.03, 0.05, 0.15]],
  [3, [0.07, 0.14, 0.38]],
  [12, [0.07, 0.19, 0.52]],
  [40, [0.06, 0.2, 0.6]],
];
const HORIZON: [number, number[]][] = [
  [-18, [0.006, 0.008, 0.016]],
  [-8, [0.03, 0.03, 0.06]],
  [-2, [0.35, 0.18, 0.14]],
  [2, [0.95, 0.52, 0.28]],
  [8, [0.9, 0.72, 0.58]],
  [20, [0.56, 0.66, 0.8]],
  [40, [0.52, 0.64, 0.8]],
];
const SUNCOL: [number, number[]][] = [
  [-3, [0, 0, 0]],
  [0, [3.2, 0.9, 0.25]],
  [4, [7.0, 3.6, 1.6]],
  [12, [9.5, 7.6, 5.6]],
  [30, [10.5, 9.8, 9.0]],
  [60, [11, 10.6, 10.2]],
];

export class Atmosphere {
  state: AtmosphereState = { timeOfDay: 15.5, sunAzimuth: 225 * (Math.PI / 180), visibility: 90000, cloudCover: 0.45 };
  sunLight: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  sky: THREE.Mesh;
  private skyMat: THREE.ShaderMaterial;
  private envScene = new THREE.Scene();
  private cubeRT: THREE.WebGLCubeRenderTarget;
  private cubeCam: THREE.CubeCamera;
  private pmrem: THREE.PMREMGenerator;
  envMap: THREE.Texture | null = null;
  private envDirty = true;
  private envTarget: THREE.WebGLRenderTarget | null = null;
  sunElevationDeg = 30;
  /** Direction of the dominant light (sun, or moon at night). */
  keyDir = new THREE.Vector3();
  keyIntensity = 1;

  constructor(private renderer: THREE.WebGLRenderer, private scene: THREE.Scene) {
    installAtmosphereChunks();
    this.skyMat = new THREE.ShaderMaterial({
      uniforms: { ...atmUniforms, uSunDisk: { value: 1 }, uInvProj: { value: new THREE.Matrix4() }, uCamMat: { value: new THREE.Matrix4() } },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        uniform mat4 uInvProj; uniform mat4 uCamMat;
        void main(){
          vec4 v = uInvProj * vec4(position.xy, 1.0, 1.0);
          vDir = (uCamMat * vec4(v.xyz / v.w, 0.0)).xyz;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vDir;
        uniform float uSunDisk;
        ${ATMOS_UNIFORMS_GLSL}
        ${NOISE_GLSL}
        ${ATMOS_FUNCS_GLSL}
        vec3 stars(vec3 d){
          vec3 p = d * 420.0;
          vec3 i = floor(p);
          float h = hash13(i);
          float s = step(0.9965, h);
          vec3 f = fract(p) - 0.5;
          float tw = 0.6 + 0.4 * sin(uAtmTime * (2.0 + h * 5.0) + h * 40.0);
          return vec3(0.9, 0.95, 1.0) * s * smoothstep(0.35, 0.0, length(f)) * (h - 0.9965) * 900.0 * tw;
        }
        void main(){
          vec3 dir = normalize(vDir);
          vec3 up = atmUp(uCamPosW);
          float camAlt = atmAlt(uCamPosW);
          vec3 col = skyBase(dir, up, camAlt);
          float du = dot(dir, up);
          // Stars & moon
          if (uNight > 0.0) {
            col += stars(dir) * uNight * smoothstep(-0.02, 0.15, du);
            float mc = dot(dir, uMoonDir);
            col += vec3(0.9, 0.93, 1.0) * smoothstep(0.99985, 0.99992, mc) * 3.0 * uNight;
            col += vec3(0.25, 0.3, 0.4) * pow(max(mc, 0.0), 300.0) * 0.12 * uNight;
          }
          // Sun disk (HDR, drives bloom)
          float sc = dot(dir, uSunDir);
          float disk = smoothstep(0.99994, 0.99997, sc);
          col += uSunColor * disk * 60.0 * uSunDisk * smoothstep(-0.01, 0.01, du + 0.02);
          // Cloud layer at ~2.4 km (flat slab approximation relative to the camera)
          float cloudAlt = 2400.0;
          if (du > 0.0 && camAlt < cloudAlt && uCloudCover > 0.01) {
            float t = (cloudAlt - camAlt) / max(du, 0.02);
            vec3 e1 = normalize(cross(up, vec3(0.0, 0.0, 1.0)));
            vec3 e2 = cross(e1, up);
            vec3 p = uCamPosW + dir * t;
            vec2 uv = vec2(dot(p, e1), dot(p, e2)) / 5200.0 + vec2(uAtmTime * 0.0012, uAtmTime * 0.0004);
            float n = fbm(uv * 1.0) * 0.65 + fbm(uv * 3.7 + 4.0) * 0.35;
            float cov = mix(0.72, 0.36, uCloudCover);
            float dens = smoothstep(cov, cov + 0.22, n);
            // cheap lighting: sample toward the sun
            vec2 sunOff = vec2(dot(uSunDir, e1), dot(uSunDir, e2)) * 0.06;
            float n2 = fbm((uv + sunOff) * 1.0) * 0.65 + fbm((uv + sunOff) * 3.7 + 4.0) * 0.35;
            float shade = clamp(1.0 - (n2 - n) * 5.0, 0.35, 1.25);
            vec3 sunlit = uSunColor * 0.085 * shade + uSkyZenith * 0.6;
            vec3 base = mix(uSkyHorizon * 0.7, uSkyZenith, 0.25) * 0.7 + uSunColor * 0.02;
            vec3 ccol = mix(base, sunlit, smoothstep(0.0, 0.9, dens));
            // silver lining toward the sun
            ccol += uSunColor * pow(max(sc, 0.0), 12.0) * 0.08 * (1.0 - dens);
            ccol = mix(ccol, vec3(0.02, 0.025, 0.04), uNight * 0.9);
            float fade = exp(-t / 60000.0) * smoothstep(0.0, 0.06, du);
            col = mix(col, ccol, dens * fade * 0.95);
          }
          gl_FragColor = vec4(col, 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
      fog: false,
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.sky = new THREE.Mesh(g, this.skyMat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1000;
    this.sky.onBeforeRender = (_r, _s, cam) => {
      this.skyMat.uniforms.uInvProj.value.copy((cam as THREE.PerspectiveCamera).projectionMatrixInverse);
      this.skyMat.uniforms.uCamMat.value.copy(cam.matrixWorld);
    };
    scene.add(this.sky);

    // Env capture scene: the same sky, without the sun disk
    const envSkyMat = this.skyMat.clone();
    envSkyMat.uniforms = { ...this.skyMat.uniforms, uSunDisk: { value: 0 }, uInvProj: { value: new THREE.Matrix4() }, uCamMat: { value: new THREE.Matrix4() } };
    for (const k of Object.keys(atmUniforms)) (envSkyMat.uniforms as any)[k] = (atmUniforms as any)[k];
    const envSky = new THREE.Mesh(g, envSkyMat);
    envSky.frustumCulled = false;
    envSky.onBeforeRender = (_r, _s, cam) => {
      envSkyMat.uniforms.uInvProj.value.copy((cam as THREE.PerspectiveCamera).projectionMatrixInverse);
      envSkyMat.uniforms.uCamMat.value.copy(cam.matrixWorld);
    };
    this.envScene.add(envSky);
    this.cubeRT = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType, generateMipmaps: false });
    this.cubeCam = new THREE.CubeCamera(1, 10, this.cubeRT);
    this.envScene.add(this.cubeCam);
    this.pmrem = new THREE.PMREMGenerator(renderer);

    this.sunLight = new THREE.DirectionalLight(0xffffff, 3);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(4096, 4096);
    this.sunLight.shadow.bias = -0.00025;
    this.sunLight.shadow.normalBias = 0.04;
    scene.add(this.sunLight);
    scene.add(this.sunLight.target);
    this.hemi = new THREE.HemisphereLight(0x8899aa, 0x223344, 0.0);
    scene.add(this.hemi);
    this.apply();
  }

  setState(s: Partial<AtmosphereState>) {
    Object.assign(this.state, s);
    this.apply();
  }

  apply() {
    const s = this.state;
    // Sun path: simple circle; elevation peaks at 62° at 13:00.
    const hourAngle = ((s.timeOfDay - 13) / 24) * Math.PI * 2;
    const elev = Math.asin(Math.cos(hourAngle) * 0.93 - 0.05) * 0.92;
    const az = s.sunAzimuth + hourAngle * 0.9;
    const el = elev;
    this.sunElevationDeg = (el * 180) / Math.PI;
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
    atmUniforms.uSunDir.value.copy(dir);
    const moon = new THREE.Vector3(-dir.x, Math.max(0.35, -dir.y), -dir.z).normalize();
    atmUniforms.uMoonDir.value.copy(moon);
    const e = this.sunElevationDeg;
    const z = gradient(ZENITH, e), h = gradient(HORIZON, e), sc = gradient(SUNCOL, e);
    atmUniforms.uSkyZenith.value.fromArray(z);
    atmUniforms.uSkyHorizon.value.fromArray(h);
    atmUniforms.uSunColor.value.fromArray(sc);
    atmUniforms.uSkyGround.value.set(h[0] * 0.35 + 0.01, h[1] * 0.4 + 0.012, h[2] * 0.45 + 0.02);
    const night = THREE.MathUtils.clamp((-e - 2) / 10, 0, 1);
    atmUniforms.uNight.value = night;
    atmUniforms.uHazeDensity.value = 3.912 / Math.max(s.visibility, 2000);
    atmUniforms.uCloudCover.value = s.cloudCover;

    // Key light: sun by day, moon by night
    const sunI = Math.max(0, THREE.MathUtils.smoothstep(e, -3, 6));
    const sunCol = new THREE.Color(sc[0], sc[1], sc[2]);
    const maxc = Math.max(sunCol.r, sunCol.g, sunCol.b, 1e-4);
    sunCol.multiplyScalar(1 / maxc);
    if (sunI > 0.02) {
      this.keyDir.copy(dir);
      this.sunLight.color.copy(sunCol);
      this.keyIntensity = 3.2 * sunI * Math.min(1, maxc / 9);
    } else {
      this.keyDir.copy(moon);
      this.sunLight.color.setRGB(0.55, 0.65, 0.9);
      this.keyIntensity = 0.12 * night;
    }
    this.sunLight.intensity = this.keyIntensity;
    this.hemi.color.setRGB(z[0] * 2, z[1] * 2, z[2] * 2);
    this.hemi.groundColor.setRGB(0.02, 0.03, 0.04);
    this.hemi.intensity = night * 0.6;
    this.envDirty = true;
  }

  /** Call once per frame before rendering. */
  update(camera: THREE.Camera, focus: THREE.Vector3, shadowRadius: number, time: number) {
    atmUniforms.uCamPosW.value.copy(camera.position);
    atmUniforms.uAtmTime.value = time;
    // Shadow frustum around the focus point.
    const L = this.sunLight;
    L.target.position.copy(focus);
    L.position.copy(focus).addScaledVector(this.keyDir, 2000);
    const cam = L.shadow.camera;
    const r = shadowRadius;
    if (cam.right !== r) {
      cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
      cam.near = 10; cam.far = 4000;
      cam.updateProjectionMatrix();
    }
    L.target.updateMatrixWorld();
    if (this.envDirty) {
      this.envDirty = false;
      this.cubeCam.position.set(0, 20, 0);
      atmUniforms.uCamPosW.value.set(0, 20, 0);
      this.cubeCam.update(this.renderer, this.envScene);
      atmUniforms.uCamPosW.value.copy(camera.position);
      if (this.envTarget) this.envTarget.dispose();
      this.envTarget = this.pmrem.fromCubemap(this.cubeRT.texture);
      this.envMap = this.envTarget.texture;
      this.scene.environment = this.envMap;
      this.scene.environmentIntensity = 1.0;
    }
  }

  /** Raw (non-PMREM) sky cube, for the ocean reflections. */
  get skyCube() {
    return this.cubeRT.texture;
  }
}
