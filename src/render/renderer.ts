import * as THREE from 'three';
import { SceneDepth, AOEffect } from './sceneDepth';
import { GradeEffect, FlareEffect, SanitizeEffect } from './post';
import { EffectComposer, RenderPass, EffectPass, BloomEffect, ToneMappingEffect, ToneMappingMode, VignetteEffect, SMAAEffect, NoiseEffect, BlendFunction, ChromaticAberrationEffect } from 'postprocessing';

export class Renderer {
  renderer: THREE.WebGLRenderer;
  composer: EffectComposer;
  bloom: BloomEffect;
  toneMapping: ToneMappingEffect;
  renderPass: RenderPass;
  chroma: ChromaticAberrationEffect;
  reversedDepth: boolean;
  exposure = 1;
  sceneDepth: SceneDepth;
  ao: AOEffect;
  grade: GradeEffect;
  flare: FlareEffect;

  constructor(container: HTMLElement, public scene: THREE.Scene, public camera: THREE.PerspectiveCamera) {
    const probe = document.createElement('canvas').getContext('webgl2');
    const hasClipControl = !!probe?.getExtension('EXT_clip_control');
    this.reversedDepth = hasClipControl;
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      reversedDepthBuffer: hasClipControl,
      logarithmicDepthBuffer: !hasClipControl,
    } as any);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.composer = new EffectComposer(this.renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 4 });
    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);
    this.bloom = new BloomEffect({
      mipmapBlur: true,
      luminanceThreshold: 1.2,
      luminanceSmoothing: 0.4,
      intensity: 0.7,
      radius: 0.72,
      levels: 8,
    });
    this.toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    this.sceneDepth = new SceneDepth(this.renderer);
    this.ao = new AOEffect(this.sceneDepth.aoRT.texture);
    this.composer.addPass(new EffectPass(camera, new SanitizeEffect(), this.ao));
    const vignette = new VignetteEffect({ offset: 0.32, darkness: 0.5 });
    const noise = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY, premultiply: false });
    noise.blendMode.opacity.value = 0.025;
    this.chroma = new ChromaticAberrationEffect({ offset: new THREE.Vector2(0.0003, 0.0003), radialModulation: true, modulationOffset: 0.35 });
    this.composer.addPass(new EffectPass(camera, this.bloom, this.toneMapping));
    this.flare = new FlareEffect(this.sceneDepth.depthRT.texture);
    this.grade = new GradeEffect();
    this.composer.addPass(new EffectPass(camera, this.flare, this.grade, this.chroma, vignette, noise));
    addEventListener('resize', () => this.resize());
    this.syncDepthSize();
  }

  private syncDepthSize() {
    const v = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.sceneDepth.setSize(v.x, v.y);
  }

  /** Current render scale (device pixel ratio actually used). */
  pixelRatio = Math.min(devicePixelRatio, 1.5);
  maxPixelRatio = Math.min(devicePixelRatio, 1.5);
  setPixelRatio(pr: number) {
    pr = Math.max(0.75, Math.min(this.maxPixelRatio, pr));
    if (Math.abs(pr - this.pixelRatio) < 0.01) return;
    this.pixelRatio = pr;
    this.renderer.setPixelRatio(pr);
    this.resize();
  }

  resize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
    this.composer.setSize(innerWidth, innerHeight);
    this.syncDepthSize();
  }

  render(dt: number) {
    this.composer.render(dt);
  }
}
