/** Shared GLSL snippets. */
export const NOISE_GLSL = /* glsl */ `
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash13(vec3 p3){ p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash12(i), hash12(i+vec2(1,0)), u.x), mix(hash12(i+vec2(0,1)), hash12(i+vec2(1,1)), u.x), u.y);
}
float vnoise3(vec3 p){
  vec3 i = floor(p), f = fract(p);
  vec3 u = f*f*(3.0-2.0*f);
  float a = hash13(i), b = hash13(i+vec3(1,0,0)), c = hash13(i+vec3(0,1,0)), d = hash13(i+vec3(1,1,0));
  float e = hash13(i+vec3(0,0,1)), f1 = hash13(i+vec3(1,0,1)), g = hash13(i+vec3(0,1,1)), h = hash13(i+vec3(1,1,1));
  return mix(mix(mix(a,b,u.x), mix(c,d,u.x), u.y), mix(mix(e,f1,u.x), mix(g,h,u.x), u.y), u.z);
}
float fbm(vec2 p){
  float s = 0.0, a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++){ s += a * vnoise(p); p = m * p; a *= 0.5; }
  return s;
}
float fbm3(vec3 p){
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++){ s += a * vnoise3(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; }
  return s;
}
`;

/**
 * Atmosphere: sky radiance + curvature-aware aerial perspective.
 * Uniforms are shared by every material (injected globally).
 */
export const ATMOS_UNIFORMS_GLSL = /* glsl */ `
uniform vec3 uSunDir;        // unit, world
uniform vec3 uSunColor;      // radiance of sun (HDR)
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyGround;
uniform vec3 uMoonDir;
uniform float uNight;        // 0 day .. 1 full night
uniform float uHazeDensity;  // extinction at sea level (1/m)
uniform float uHazeHeight;   // scale height (m)
uniform float uCloudCover;   // 0..1
uniform float uAtmTime;      // seconds
uniform vec3 uCamPosW;       // camera world pos
uniform float uPlanetR;
`;

export const ATMOS_FUNCS_GLSL = /* glsl */ `
vec3 atmUp(vec3 p){ return normalize(p - vec3(0.0, -uPlanetR, 0.0)); }
float atmAlt(vec3 p){ return length(p - vec3(0.0, -uPlanetR, 0.0)) - uPlanetR; }

// Henyey-Greenstein
float hgPhase(float c, float g){ float g2 = g*g; return (1.0 - g2) / (4.0*3.14159*pow(max(1.0 + g2 - 2.0*g*c, 1e-4), 1.5)); }

// Sky radiance without the sun disk. dir = unit world direction. up = local up at camera.
vec3 skyBase(vec3 dir, vec3 up, float camAlt){
  float dip = acos(clamp(uPlanetR / (uPlanetR + max(camAlt, 0.0)), 0.0, 1.0));
  float el = asin(clamp(dot(dir, up), -1.0, 1.0)) + dip; // elevation above the true horizon
  float h = max(el, 0.0);
  float t = pow(clamp(h / 1.5708, 0.0, 1.0), 0.45);
  vec3 col = mix(uSkyHorizon, uSkyZenith, t);
  // Sun-side brightening near the horizon (Mie glow)
  float c = dot(dir, uSunDir);
  float sunUp = clamp(dot(uSunDir, up) * 4.0 + 0.6, 0.0, 1.0);
  col += uSunColor * (hgPhase(c, 0.76) * 0.035 + hgPhase(c, 0.3) * 0.02) * mix(1.0, 0.35, t) * sunUp;
  // Below the horizon: fade to a dark haze band (visible from altitude)
  float below = smoothstep(0.0, -0.08, el);
  col = mix(col, uSkyGround, below);
  return col;
}

// Aerial perspective between camera and a world point.
vec3 applyAtmosphere(vec3 color, vec3 wp){
  vec3 d = wp - uCamPosW;
  float dist = length(d);
  if (dist < 1.0) return color;
  vec3 dir = d / dist;
  float a0 = atmAlt(uCamPosW);
  float a1 = atmAlt(uCamPosW + d * 0.5);
  float a2 = atmAlt(wp);
  float r0 = exp(-max(a0, 0.0) / uHazeHeight), r1 = exp(-max(a1, 0.0) / uHazeHeight), r2 = exp(-max(a2, 0.0) / uHazeHeight);
  float tau = uHazeDensity * dist * (r0 + 4.0 * r1 + r2) / 6.0;
  float T = exp(-tau);
  vec3 up = atmUp(uCamPosW);
  // In-scattered light ~ sky near the horizon in this azimuth.
  vec3 hdir = normalize(dir - up * (dot(dir, up) - 0.02));
  vec3 ins = skyBase(hdir, up, 0.0);
  return color * T + ins * (1.0 - T);
}
`;
