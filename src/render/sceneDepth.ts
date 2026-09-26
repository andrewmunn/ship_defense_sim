import * as THREE from 'three';
import { Effect, BlendFunction } from 'postprocessing';

/** Layer for solid geometry that participates in the depth prepass (ship, terrain, launchers). */
export const OCCLUDER_LAYER = 1;
/** Depth is stored in kilometres in a half-float target; cleared to FAR_KM. */
const FAR_KM = 60;

const depthMat = new THREE.ShaderMaterial({
  vertexShader: /* glsl */ `
    #include <common>
    #include <logdepthbuf_pars_vertex>
    varying float vViewZ;
    varying vec3 vNrm;
    void main(){
      #include <beginnormal_vertex>
      #include <defaultnormal_vertex>
      vNrm = normalize(transformedNormal);
      #include <begin_vertex>
      #include <project_vertex>
      vViewZ = -mvPosition.z;
      #include <logdepthbuf_vertex>
    }`,
  fragmentShader: /* glsl */ `
    #include <common>
    #include <logdepthbuf_pars_fragment>
    varying float vViewZ;
    varying vec3 vNrm;
    void main(){
      #include <logdepthbuf_fragment>
      vec3 n = normalize(vNrm) * (gl_FrontFacing ? 1.0 : -1.0);
      gl_FragColor = vec4(vViewZ * 0.001, n);
    }`,
  side: THREE.DoubleSide,
});

const quadVert = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const aoMat = new THREE.ShaderMaterial({
  uniforms: {
    uDepth: { value: null as THREE.Texture | null },
    uTexel: { value: new THREE.Vector2() },
    uTanHalf: { value: new THREE.Vector2(1, 1) },
    uRadius: { value: 2.6 },
    uIntensity: { value: 2.6 },
    uTime: { value: 0 },
  },
  vertexShader: quadVert,
  fragmentShader: /* glsl */ `
    uniform sampler2D uDepth;
    uniform vec2 uTexel;
    uniform vec2 uTanHalf;
    uniform float uRadius;
    uniform float uIntensity;
    uniform float uTime;
    varying vec2 vUv;
    float D(vec2 uv){ return texture2D(uDepth, uv).r * 1000.0; }
    vec3 P(vec2 uv, float d){ return vec3((uv * 2.0 - 1.0) * uTanHalf * d, -d); }
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main(){
      float d = D(vUv);
      if (d > ${FAR_KM * 1000 - 100}.0) { gl_FragColor = vec4(1.0); return; }
      vec3 p = P(vUv, d);
      vec3 n = normalize(texture2D(uDepth, vUv).gba); // exact view-space geometric normal from the prepass
      // screen radius of a world-space hemisphere
      float rs = uRadius / (d * uTanHalf.y * 2.0);
      if (rs < uTexel.y * 1.5) { gl_FragColor = vec4(1.0); return; }
      rs = min(rs, 0.12);
      const int N = 14;
      float ang = hash(gl_FragCoord.xy + uTime) * 6.2831;
      float occ = 0.0;
      for (int i = 0; i < N; i++) {
        float t = (float(i) + 0.5) / float(N);
        float a = ang + t * 6.2831 * 3.0;
        vec2 o = vec2(cos(a), sin(a)) * rs * t;
        vec2 suv = vUv + o;
        float sd = D(suv);
        vec3 v = P(suv, sd) - p;
        float vv = dot(v, v);
        float vn = dot(v, n) - 0.0025 * d - 0.02;
        float range = smoothstep(0.0, 1.0, uRadius * uRadius / max(vv, 1e-4) * 0.25);
        occ += max(vn, 0.0) / (vv + 0.05) * range;
      }
      float ao = clamp(1.0 - uIntensity * occ * uRadius / float(N), 0.0, 1.0);
      gl_FragColor = vec4(vec3(ao), 1.0);
    }`,
  depthTest: false,
  depthWrite: false,
});

const blurMat = new THREE.ShaderMaterial({
  uniforms: { uAO: { value: null as THREE.Texture | null }, uDepth: { value: null as THREE.Texture | null }, uDir: { value: new THREE.Vector2() } },
  vertexShader: quadVert,
  fragmentShader: /* glsl */ `
    uniform sampler2D uAO; uniform sampler2D uDepth; uniform vec2 uDir; varying vec2 vUv;
    void main(){
      float d0 = texture2D(uDepth, vUv).r;
      float s = 0.0, w = 0.0;
      for (int i = -4; i <= 4; i++) {
        vec2 uv = vUv + uDir * float(i);
        float d = texture2D(uDepth, uv).r;
        float wi = exp(-float(i * i) / 10.0) * exp(-abs(d - d0) / max(d0 * 0.02, 1e-5));
        s += texture2D(uAO, uv).r * wi;
        w += wi;
      }
      gl_FragColor = vec4(vec3(s / max(w, 1e-4)), 1.0);
    }`,
  depthTest: false,
  depthWrite: false,
});

/** Applies the blurred AO buffer to the HDR colour before bloom / tone mapping. */
export class AOEffect extends Effect {
  constructor(ao: THREE.Texture) {
    super('AOEffect', /* glsl */ `
      uniform sampler2D uAOTex;
      uniform float uStrength;
      uniform float uDebug;
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor){
        float ao = texture2D(uAOTex, uv).r;
        outputColor = vec4(inputColor.rgb * mix(1.0, ao, uStrength), inputColor.a);
        if (uDebug > 0.5) outputColor = vec4(vec3(ao), 1.0);
      }`, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, THREE.Uniform>([
        ['uAOTex', new THREE.Uniform(ao)],
        ['uStrength', new THREE.Uniform(0.85)],
        ['uDebug', new THREE.Uniform(0)],
      ]),
    });
  }
}

/**
 * Linear-depth prepass of solid geometry (layer OCCLUDER_LAYER) → soft particles & SSAO.
 * Call update() every frame before the composer renders.
 */
export class SceneDepth {
  depthRT: THREE.WebGLRenderTarget;
  aoRT: THREE.WebGLRenderTarget;
  private aoTmp: THREE.WebGLRenderTarget;
  private cam = new THREE.PerspectiveCamera();
  private quad: THREE.Mesh;
  private quadScene = new THREE.Scene();
  private orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  enabledAO = true;
  resolution = new THREE.Vector2(1, 1);

  constructor(private renderer: THREE.WebGLRenderer) {
    const opts = { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true, stencilBuffer: false };
    this.depthRT = new THREE.WebGLRenderTarget(1, 1, opts);
    this.aoRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.UnsignedByteType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
    this.aoTmp = this.aoRT.clone();
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), aoMat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
    this.cam.layers.set(OCCLUDER_LAYER);
  }

  setSize(w: number, h: number) {
    this.depthRT.setSize(w, h);
    const aw = Math.max(1, Math.floor(w / 2)), ah = Math.max(1, Math.floor(h / 2));
    this.aoRT.setSize(aw, ah);
    this.aoTmp.setSize(aw, ah);
    this.resolution.set(w, h);
  }

  update(scene: THREE.Scene, camera: THREE.PerspectiveCamera, time: number) {
    const r = this.renderer;
    const cam = this.cam;
    cam.copy(camera, false);
    cam.layers.set(OCCLUDER_LAYER);
    const prevOverride = scene.overrideMaterial, prevBg = scene.background, prevFog = scene.fog;
    const prevTarget = r.getRenderTarget();
    const prevClear = r.getClearColor(new THREE.Color()), prevAlpha = r.getClearAlpha();
    const prevAuto = r.shadowMap.autoUpdate;
    r.shadowMap.autoUpdate = false;
    scene.overrideMaterial = depthMat;
    scene.background = null;
    scene.fog = null;
    r.setRenderTarget(this.depthRT);
    r.setClearColor(new THREE.Color(FAR_KM, 0, 0), 1);
    r.clear(true, true, false);
    r.render(scene, cam);
    scene.overrideMaterial = prevOverride;
    scene.background = prevBg;
    scene.fog = prevFog;
    r.shadowMap.autoUpdate = prevAuto;
    if (this.enabledAO) {
      const tanY = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
      aoMat.uniforms.uDepth.value = this.depthRT.texture;
      aoMat.uniforms.uTexel.value.set(1 / this.resolution.x, 1 / this.resolution.y);
      aoMat.uniforms.uTanHalf.value.set(tanY * camera.aspect, tanY);
      aoMat.uniforms.uTime.value = time % 10;
      this.quad.material = aoMat;
      r.setRenderTarget(this.aoRT);
      r.render(this.quadScene, this.orthoCam);
      blurMat.uniforms.uDepth.value = this.depthRT.texture;
      this.quad.material = blurMat;
      blurMat.uniforms.uAO.value = this.aoRT.texture;
      blurMat.uniforms.uDir.value.set(1 / this.aoRT.width, 0);
      r.setRenderTarget(this.aoTmp);
      r.render(this.quadScene, this.orthoCam);
      blurMat.uniforms.uAO.value = this.aoTmp.texture;
      blurMat.uniforms.uDir.value.set(0, 1 / this.aoRT.height);
      r.setRenderTarget(this.aoRT);
      r.render(this.quadScene, this.orthoCam);
    }
    r.setRenderTarget(prevTarget);
    r.setClearColor(prevClear, prevAlpha);
  }
}
