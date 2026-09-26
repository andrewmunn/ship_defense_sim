import * as THREE from 'three';
import { Effect, BlendFunction } from 'postprocessing';

/** Filmic grade after tone mapping: split-tone (cool shadows / warm highlights), gentle S-curve, saturation. */
export class GradeEffect extends Effect {
  constructor() {
    super('GradeEffect', /* glsl */ `
      uniform float uContrast;
      uniform float uSat;
      uniform vec3 uShadowTint;
      uniform vec3 uHighTint;
      uniform float uNight;
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor){
        vec3 c = inputColor.rgb;
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        // split toning
        vec3 tint = mix(uShadowTint, uHighTint, smoothstep(0.15, 0.75, l));
        c *= mix(vec3(1.0), tint, 0.5);
        // S-curve around mid-grey
        c = clamp(c, 0.0, 1.0);
        vec3 s = c * c * (3.0 - 2.0 * c);
        c = mix(c, s, uContrast);
        // saturation (less at night: scotopic vision)
        float l2 = dot(c, vec3(0.2126, 0.7152, 0.0722));
        c = mix(vec3(l2), c, uSat * mix(1.0, 0.7, uNight));
        outputColor = vec4(c, inputColor.a);
      }`, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, THREE.Uniform>([
        ['uContrast', new THREE.Uniform(0.28)],
        ['uSat', new THREE.Uniform(1.08)],
        ['uShadowTint', new THREE.Uniform(new THREE.Vector3(0.94, 0.99, 1.08))],
        ['uHighTint', new THREE.Uniform(new THREE.Vector3(1.06, 1.01, 0.93))],
        ['uNight', new THREE.Uniform(0)],
      ]),
    });
  }
}

/**
 * Sun glare: soft bloom halo, a thin anamorphic streak and a few lens ghosts, faded by an
 * occlusion probe of the depth prepass around the sun's screen position.
 */
export class FlareEffect extends Effect {
  constructor(depth: THREE.Texture) {
    super('FlareEffect', /* glsl */ `
      uniform vec2 uSun;        // screen uv of the sun
      uniform float uVis;       // 0..1 (on screen, above horizon, not occluded)
      uniform vec3 uCol;
      uniform float uAspect;
      uniform sampler2D uDepthTex;
      float occl(vec2 p){
        // fraction of probe taps that hit geometry (ship etc.) near the sun
        float o = 0.0;
        for (int i = 0; i < 9; i++) {
          vec2 d = vec2(float(i % 3) - 1.0, float(i / 3) - 1.0) * 0.006;
          o += step(texture2D(uDepthTex, p + d).r, 50.0);
        }
        return o / 9.0;
      }
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor){
        vec3 add = vec3(0.0);
        if (uVis > 0.001) {
          float vis = uVis * (1.0 - occl(uSun));
          vec2 d = uv - uSun;
          d.x *= uAspect;
          float r = length(d);
          add += uCol * exp(-r * 9.0) * 0.18 * vis;                       // halo
          add += uCol * exp(-abs(d.y) * 380.0) * exp(-abs(d.x) * 2.2) * 0.22 * vis; // anamorphic streak
          // star
          float a = atan(d.y, d.x);
          add += uCol * pow(abs(cos(a * 3.0)), 60.0) * exp(-r * 14.0) * 0.25 * vis;
          // ghosts along the axis through the screen centre
          vec2 axis = vec2(0.5) - uSun;
          for (int i = 1; i <= 4; i++) {
            float k = float(i) * 0.55 - 0.2;
            vec2 gp = uSun + axis * k * 2.0;
            vec2 gd = uv - gp; gd.x *= uAspect;
            float gr = 0.02 + 0.018 * float(i);
            float g = smoothstep(gr, gr * 0.6, length(gd)) - 0.6 * smoothstep(gr * 0.8, gr * 0.3, length(gd));
            vec3 gc = i == 2 ? vec3(0.4, 0.7, 1.0) : i == 3 ? vec3(1.0, 0.6, 0.3) : vec3(0.7, 1.0, 0.6);
            add += gc * g * 0.035 * vis;
          }
        }
        outputColor = vec4(inputColor.rgb + add, inputColor.a);
      }`, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, THREE.Uniform>([
        ['uSun', new THREE.Uniform(new THREE.Vector2(0.5, 0.5))],
        ['uVis', new THREE.Uniform(0)],
        ['uCol', new THREE.Uniform(new THREE.Vector3(1, 0.9, 0.75))],
        ['uAspect', new THREE.Uniform(1)],
        ['uDepthTex', new THREE.Uniform(depth)],
      ]),
    });
  }

  private _p = new THREE.Vector3();
  private _f = new THREE.Vector3();
  /** Update from the camera and the (world) sun direction. */
  track(camera: THREE.PerspectiveCamera, sunDir: THREE.Vector3, sunColor: THREE.Color, sunElevDeg: number) {
    const p = this._p.copy(camera.position).addScaledVector(sunDir, 1e5).project(camera);
    const u = this.uniforms;
    const behind = this._f.set(0, 0, -1).applyQuaternion(camera.quaternion).dot(sunDir) < 0;
    // the planet itself can hide the sun (high-altitude views of the night side / low sun)
    const R = 1_000_000;
    const cx = camera.position.x, cy = camera.position.y + R, cz = camera.position.z;
    const b = cx * sunDir.x + cy * sunDir.y + cz * sunDir.z;
    const disc = b * b - (cx * cx + cy * cy + cz * cz - R * R);
    const planetBlocks = disc > 0 && -b - Math.sqrt(disc) > 0;
    const onScreen = !behind && !planetBlocks && Math.abs(p.x) < 1.25 && Math.abs(p.y) < 1.25;
    const edge = THREE.MathUtils.clamp(1.25 - Math.max(Math.abs(p.x), Math.abs(p.y)), 0, 0.3) / 0.3;
    const elev = THREE.MathUtils.smoothstep(sunElevDeg, -1, 3);
    (u.get('uSun')!.value as THREE.Vector2).set(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5);
    u.get('uVis')!.value = onScreen ? edge * elev : 0;
    (u.get('uCol')!.value as THREE.Vector3).set(sunColor.r, sunColor.g * 0.95, sunColor.b * 0.85);
    u.get('uAspect')!.value = camera.aspect;
  }
}
