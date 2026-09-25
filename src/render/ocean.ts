import * as THREE from 'three';
import { R_PLANET } from '../core/constants';
import { WaveField, MAX_WAVES } from '../sim/waves';
import { atmUniforms } from './atmosphere';
import { ATMOS_FUNCS_GLSL, ATMOS_UNIFORMS_GLSL, NOISE_GLSL } from './shaders/common.glsl';
import { makeDetailNormalTexture, makeFoamTexture } from './oceanTextures';

const RING_GROWTH = 1.0245;
const ANG_SEG = 256;
const R_MIN = 0.35;
const R_MAX = 600_000;

function buildRadialGrid() {
  const rings: number[] = [0];
  let r = R_MIN;
  while (r < R_MAX) {
    rings.push(r);
    r *= RING_GROWTH;
    if (r < 2) r = Math.max(r, rings[rings.length - 1] + 0.12);
  }
  rings.push(R_MAX);
  const nR = rings.length;
  const pos = new Float32Array((1 + (nR - 1) * ANG_SEG) * 3);
  let o = 3; // vertex 0 = center
  for (let i = 1; i < nR; i++) {
    for (let a = 0; a < ANG_SEG; a++) {
      const th = (a / ANG_SEG) * Math.PI * 2 + (i % 2) * (Math.PI / ANG_SEG);
      pos[o++] = Math.cos(th) * rings[i];
      pos[o++] = 0;
      pos[o++] = Math.sin(th) * rings[i];
    }
  }
  const idx: number[] = [];
  for (let a = 0; a < ANG_SEG; a++) idx.push(0, 1 + ((a + 1) % ANG_SEG), 1 + a);
  for (let i = 1; i < nR - 1; i++) {
    const b0 = 1 + (i - 1) * ANG_SEG, b1 = 1 + i * ANG_SEG;
    for (let a = 0; a < ANG_SEG; a++) {
      const a1 = (a + 1) % ANG_SEG;
      idx.push(b0 + a, b0 + a1, b1 + a);
      idx.push(b0 + a1, b1 + a1, b1 + a);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), R_MAX * 2);
  return g;
}

const WAVE_GLSL = /* glsl */ `
#define NW ${MAX_WAVES}
uniform vec4 uWaveA[NW]; // dirX, dirZ, k, amp
uniform vec4 uWaveB[NW]; // steep, phase(at grid center), wavelength, 0
`;

export class Ocean {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  waves: WaveField;
  private uWaveA: THREE.Vector4[] = [];
  private uWaveB: THREE.Vector4[] = [];

  constructor(waves: WaveField, skyCube: THREE.Texture) {
    this.waves = waves;
    for (let i = 0; i < MAX_WAVES; i++) {
      this.uWaveA.push(new THREE.Vector4());
      this.uWaveB.push(new THREE.Vector4());
    }
    const detail = makeDetailNormalTexture();
    const foam = makeFoamTexture();
    const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.lights]);
    Object.assign(uniforms, atmUniforms, {
      uWaveA: { value: this.uWaveA },
      uWaveB: { value: this.uWaveB },
      uTime: { value: 0 },
      uDetail: { value: detail },
      uFoamTex: { value: foam },
      uSkyCube: { value: skyCube },
      uDetailOff: { value: [new THREE.Vector2(), new THREE.Vector2(), new THREE.Vector2()] },
      uDetailStrength: { value: 1 },
      uSeaState: { value: 3 },
      uFoamMap: { value: null as THREE.Texture | null },
      uFoamMapOn: { value: 0 },
      uFoamMapRect: { value: new THREE.Vector4(0, 0, 1, 1) }, // minX, minZ, 1/sizeX, 1/sizeZ relative to grid center
      uLightDir: { value: new THREE.Vector3() },
      uLightCol: { value: new THREE.Vector3() },
      uExplLights: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] }, // xyz rel. to grid center, w = radius
      uExplColors: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
    });
    this.material = new THREE.ShaderMaterial({
      uniforms,
      lights: true,
      fog: false,
      vertexShader: /* glsl */ `
        ${WAVE_GLSL}
        #include <common>
        #include <shadowmap_pars_vertex>
        uniform float uPlanetR;
        varying vec2 vLocal;      // undisplaced offset from grid center
        varying vec3 vWorld;      // world position (for atmosphere)
        varying vec3 vRel;        // position relative to grid center (precise)
        varying float vDist;
        varying float vHeight;
        void main(){
          vec2 local = position.xz;
          float dist = length(local);
          float spacing = max(dist * 0.0245, 0.12);
          vec3 disp = vec3(0.0);
          for (int i = 0; i < NW; i++) {
            vec4 A = uWaveA[i]; vec4 B = uWaveB[i];
            float fade = smoothstep(2.5 * spacing, 5.0 * spacing, B.z);
            float th = A.z * dot(A.xy, local) + B.y;
            float c = cos(th), s = sin(th);
            float qa = B.x * A.w * fade;
            disp.x += qa * A.x * c;
            disp.z += qa * A.y * c;
            disp.y += A.w * s * fade;
          }
          // far away: flatten completely (sub-pixel)
          vec3 gridW = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          vec2 wxz = gridW.xz + local;
          float d2 = dot(wxz, wxz);
          float sphereY = -d2 / (uPlanetR + sqrt(max(uPlanetR * uPlanetR - d2, 0.0)));
          vec3 rel = vec3(local.x + disp.x, sphereY + disp.y, local.y + disp.z);
          vLocal = local;
          vRel = rel;
          vHeight = disp.y;
          vec4 wp = modelMatrix * vec4(rel, 1.0);
          vWorld = wp.xyz;
          vDist = dist;
          vec4 mv = modelViewMatrix * vec4(rel, 1.0);
          gl_Position = projectionMatrix * mv;
          #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
            vDirectionalShadowCoord[0] = directionalShadowMatrix[0] * wp;
          #endif
        }`,
      fragmentShader: /* glsl */ `
        ${WAVE_GLSL}
        #include <common>
        #include <packing>
        #include <lights_pars_begin>
        #include <shadowmap_pars_fragment>
        ${ATMOS_UNIFORMS_GLSL}
        ${NOISE_GLSL}
        ${ATMOS_FUNCS_GLSL}
        uniform float uTime;
        uniform sampler2D uDetail;
        uniform sampler2D uFoamTex;
        uniform samplerCube uSkyCube;
        uniform vec2 uDetailOff[3];
        uniform float uDetailStrength;
        uniform float uSeaState;
        uniform sampler2D uFoamMap;
        uniform float uFoamMapOn;
        uniform vec4 uFoamMapRect;
        uniform vec3 uLightDir;
        uniform vec3 uLightCol;
        uniform vec4 uExplLights[4];
        uniform vec3 uExplColors[4];
        varying vec2 vLocal;
        varying vec3 vWorld;
        varying vec3 vRel;
        varying float vDist;
        varying float vHeight;

        float D_GGX(float NoH, float a){ float a2 = a*a; float d = NoH*NoH*(a2-1.0)+1.0; return a2/(3.14159*d*d); }

        void main(){
          vec2 local = vLocal;
          // pixel footprint in meters
          float fp = length(fwidth(local)) + 1e-3;
          // Gerstner normal + Jacobian (per pixel)
          vec3 dPdx = vec3(1.0, 0.0, 0.0), dPdz = vec3(0.0, 0.0, 1.0);
          float jac = 1.0;
          float lostVar = 0.0;
          float Jxx = 1.0, Jzz = 1.0, Jxz = 0.0;
          for (int i = 0; i < NW; i++) {
            vec4 A = uWaveA[i]; vec4 B = uWaveB[i];
            float fade = smoothstep(1.5 * fp, 6.0 * fp, B.z);
            float th = A.z * dot(A.xy, local) + B.y;
            float c = cos(th), s = sin(th);
            float wa = A.z * A.w;
            float slopeT = wa * c * fade;
            dPdx.y += A.x * slopeT;
            dPdz.y += A.y * slopeT;
            float qs = B.x * wa * s * fade;
            Jxx -= qs * A.x * A.x;
            Jzz -= qs * A.y * A.y;
            Jxz -= qs * A.x * A.y;
            lostVar += (1.0 - fade) * wa * wa * 0.5;
          }
          jac = Jxx * Jzz - Jxz * Jxz;
          vec3 N = normalize(vec3(-dPdx.y, 1.0, -dPdz.y));

          // Detail normals (3 scrolling octaves), faded with distance
          vec2 w = vWorld.xz;
          float dFade = exp(-vDist / 900.0);
          float dFade2 = exp(-vDist / 220.0);
          vec2 uv0 = local / 61.0 + uDetailOff[0];
          vec2 uv1 = mat2(0.8, -0.6, 0.6, 0.8) * local / 17.3 + uDetailOff[1];
          vec2 uv2 = mat2(0.28, 0.96, -0.96, 0.28) * local / 4.1 + uDetailOff[2];
          vec3 t0 = texture2D(uDetail, uv0).xyz * 2.0 - 1.0;
          vec3 t1 = texture2D(uDetail, uv1).xyz * 2.0 - 1.0;
          vec3 t2 = texture2D(uDetail, uv2).xyz * 2.0 - 1.0;
          float ss = 0.25 + 0.12 * uSeaState;
          vec2 dn = t0.xy * 0.20 * ss * (0.35 + 0.65 * dFade)
                  + mat2(0.8, 0.6, -0.6, 0.8) * t1.xy * 0.20 * ss * dFade
                  + mat2(0.28, -0.96, 0.96, 0.28) * t2.xy * 0.16 * ss * dFade2;
          dn *= uDetailStrength;
          N = normalize(N + vec3(dn.x, 0.0, dn.y));

          // Curvature: tilt the normal to the local radial up
          vec3 up = atmUp(vWorld);
          // build a frame where +Y = up (small rotation from world Y)
          vec3 axis = cross(vec3(0.0, 1.0, 0.0), up);
          float sa = length(axis);
          if (sa > 1e-6) {
            axis /= sa; float ca = up.y;
            N = N * ca + cross(axis, N) * sa + axis * dot(axis, N) * (1.0 - ca);
          }

          vec3 camRel = uCamPosW - vWorld;
          float distCam = length(camRel);
          vec3 V = camRel / distCam;
          float NoV = max(dot(N, V), 0.001);
          float F = 0.02 + 0.98 * pow(1.0 - NoV, 5.0);

          // Reflection
          vec3 Rv = reflect(-V, N);
          float ru = dot(Rv, up);
          if (ru < 0.0) Rv = normalize(Rv - up * ru * 2.0);
          vec3 refl = textureCube(uSkyCube, Rv).rgb;

          // Sun/moon glitter (GGX, roughness grows with lost sub-pixel wave energy)
          vec3 L = uLightDir;
          vec3 H = normalize(L + V);
          float rough = clamp(0.035 + sqrt(lostVar) * 0.9 + (1.0 - dFade) * 0.06 + 0.01 * uSeaState, 0.03, 0.4);
          float NoL = max(dot(N, L), 0.0);
          float spec = D_GGX(max(dot(N, H), 0.0), rough) * F / max(4.0 * NoV, 0.2) * NoL;
          float shadow = 1.0;
          #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
            shadow = getShadow(directionalShadowMap[0], directionalLightShadows[0].shadowMapSize, directionalLightShadows[0].shadowIntensity, directionalLightShadows[0].shadowBias, directionalLightShadows[0].shadowRadius, vDirectionalShadowCoord[0]);
          #endif
          vec3 specCol = uLightCol * spec * shadow;

          // Water body: deep color lit by sky + sun, with subsurface glow on crests
          vec3 skyAmb = uSkyZenith * 0.55 + uSkyHorizon * 0.35;
          vec3 deep = vec3(0.004, 0.018, 0.034);
          vec3 scatterCol = vec3(0.03, 0.14, 0.15);
          float sunUp = clamp(dot(L, up), 0.0, 1.0);
          vec3 body = deep * (skyAmb * 1.5 + uLightCol * 0.05 * sunUp * shadow);
          float crest = clamp(vHeight / (0.3 + 0.4 * uSeaState), 0.0, 1.0);
          float sssView = pow(clamp(dot(V, -L) * 0.5 + 0.5, 0.0, 1.0), 3.0);
          body += scatterCol * uLightCol * 0.018 * (crest * 1.2 + 0.15) * (0.4 + sssView) * shadow * sunUp;
          body += scatterCol * skyAmb * 0.25 * crest;

          vec3 col = mix(body, refl, F) + specCol;

          // Whitecaps from wave folding + ship wake / splash foam map
          float foamT = texture2D(uFoamTex, w / 23.0 + uDetailOff[1] * 0.3).r;
          float foamT2 = texture2D(uFoamTex, w / 7.1 - uDetailOff[0] * 0.5).r;
          float fold = clamp((0.62 - jac) * 2.2, 0.0, 1.0) * smoothstep(1.5, 3.5, uSeaState);
          float foam = fold * smoothstep(0.35, 0.75, foamT * 0.6 + foamT2 * 0.5);
          if (uFoamMapOn > 0.5) {
            vec2 fuv = (vRel.xz - uFoamMapRect.xy) * uFoamMapRect.zw;
            if (all(greaterThan(fuv, vec2(0.0))) && all(lessThan(fuv, vec2(1.0)))) {
              vec4 fm = texture2D(uFoamMap, fuv);
              float edge = smoothstep(0.0, 0.05, min(min(fuv.x, fuv.y), min(1.0 - fuv.x, 1.0 - fuv.y)));
              float f = fm.r * edge;
              float tex = smoothstep(0.15, 0.85, foamT2 * 0.7 + foamT * 0.5 + f * 0.6 - 0.2);
              foam = max(foam, clamp(f * 1.4, 0.0, 1.0) * mix(tex, 1.0, clamp(f - 0.6, 0.0, 1.0)));
            }
          }
          vec3 foamCol = (skyAmb * 0.9 + uLightCol * 0.09 * NoL * shadow + vec3(0.02)) * 0.9;
          col = mix(col, foamCol, clamp(foam, 0.0, 1.0) * 0.92);

          // Explosion / fire light on water
          for (int i = 0; i < 4; i++) {
            vec4 el = uExplLights[i];
            if (el.w <= 0.0) continue;
            vec3 d = el.xyz - vRel;
            float dl = length(d);
            float att = el.w * el.w / (dl * dl + el.w * 2.0);
            vec3 Le = d / dl;
            vec3 He = normalize(Le + V);
            float se = D_GGX(max(dot(N, He), 0.0), max(rough, 0.08)) * F * 0.25;
            col += uExplColors[i] * att * (max(dot(N, Le), 0.0) * 0.02 + se);
          }

          col = applyAtmosphere(col, vWorld);
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(buildRadialGrid(), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = -10;
    this.setSeaState(waves.seaState);
  }

  setSeaState(s: number) {
    this.material.uniforms.uSeaState.value = s;
  }

  /** Position the grid under the camera and advance wave phases (phases computed in double precision). */
  update(camera: THREE.Camera, t: number, lightDir: THREE.Vector3, lightCol: THREE.Color, lightIntensity: number) {
    const cx = camera.position.x, cz = camera.position.z;
    this.mesh.position.set(cx, 0, cz);
    this.mesh.updateMatrixWorld();
    const W = this.waves.waves;
    for (let i = 0; i < MAX_WAVES; i++) {
      const w = W[i];
      if (!w) {
        this.uWaveA[i].set(1, 0, 1, 0);
        this.uWaveB[i].set(0, 0, 1, 0);
        continue;
      }
      let ph = w.k * (w.dirX * cx + w.dirZ * cz) - w.omega * t + w.phase;
      ph = ph % (Math.PI * 2);
      this.uWaveA[i].set(w.dirX, w.dirZ, w.k, w.amp);
      this.uWaveB[i].set(w.steep, ph, (2 * Math.PI) / w.k, 0);
    }
    const u = this.material.uniforms;
    u.uTime.value = t;
    // Detail layer offsets: scroll + account for grid origin (mod 1 in texture space, double precision)
    const offs = u.uDetailOff.value as THREE.Vector2[];
    const frac = (v: number) => v - Math.floor(v);
    const s0 = 61, s1 = 17.3, s2 = 4.1;
    offs[0].set(frac(cx / s0 + t * 0.011), frac(cz / s0 + t * 0.006));
    // rotated layers: rotate the center by the same matrix
    const r1x = 0.8 * cx + 0.6 * cz, r1z = -0.6 * cx + 0.8 * cz;
    offs[1].set(frac(r1x / s1 - t * 0.021), frac(r1z / s1 + t * 0.017));
    const r2x = 0.28 * cx - 0.96 * cz, r2z = 0.96 * cx + 0.28 * cz;
    offs[2].set(frac(r2x / s2 + t * 0.05), frac(r2z / s2 - t * 0.038));
    u.uLightDir.value.copy(lightDir);
    u.uLightCol.value.set(lightCol.r, lightCol.g, lightCol.b).multiplyScalar(lightIntensity * 3.0);
  }
}

export { R_PLANET };
