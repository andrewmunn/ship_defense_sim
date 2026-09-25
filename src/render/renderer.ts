import * as THREE from 'three';
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
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
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
      luminanceThreshold: 1.1,
      luminanceSmoothing: 0.35,
      intensity: 1.1,
      radius: 0.78,
      levels: 8,
    });
    this.toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    const vignette = new VignetteEffect({ offset: 0.32, darkness: 0.5 });
    const noise = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY, premultiply: false });
    noise.blendMode.opacity.value = 0.025;
    this.chroma = new ChromaticAberrationEffect({ offset: new THREE.Vector2(0.0003, 0.0003), radialModulation: true, modulationOffset: 0.35 });
    this.composer.addPass(new EffectPass(camera, this.bloom, this.toneMapping));
    this.composer.addPass(new EffectPass(camera, this.chroma, vignette, noise));
    addEventListener('resize', () => this.resize());
  }

  resize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
    this.composer.setSize(innerWidth, innerHeight);
  }

  render(dt: number) {
    this.composer.render(dt);
  }
}
