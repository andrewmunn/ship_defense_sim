import { ChunkGenerator, GenParams, ChunkJob, ScatterJob, genScatter, LandUse } from './gen';

// Note: no `/// <reference lib="webworker" />` — that would leak worker globals into the DOM typings project-wide.
const ctx = self as unknown as {
  postMessage(m: unknown, t?: Transferable[]): void;
  onmessage: ((e: MessageEvent) => void) | null;
};

let gen: ChunkGenerator | null = null;
let lu: LandUse | null = null;

ctx.onmessage = (ev: MessageEvent) => {
  const m = ev.data as { type: 'init'; params: GenParams } | { type: 'chunk'; job: ChunkJob } | { type: 'scatter'; job: ScatterJob };
  if (m.type === 'init') {
    gen = new ChunkGenerator(m.params);
    lu = new LandUse(m.params.macro ?? null, m.params.macroSize ?? 512, m.params.towns ?? []);
    return;
  }
  if (!gen) return;
  if (m.type === 'chunk') {
    const r = gen.gen(m.job);
    const transfer: Transferable[] = [r.pos.buffer, r.nrm.buffer, r.tex.buffer, r.ext.buffer];
    ctx.postMessage({ type: 'chunk', r }, transfer);
  } else if (m.type === 'scatter') {
    const r = genScatter(gen, lu!, m.job);
    ctx.postMessage({ type: 'scatter', r }, [r.data.buffer]);
  }
};
