type Handler<T> = (e: T) => void;

/** Minimal typed event bus. */
export class Emitter<M extends Record<string, any>> {
  private h: { [K in keyof M]?: Handler<M[K]>[] } = {};
  on<K extends keyof M>(k: K, f: Handler<M[K]>) {
    (this.h[k] ??= []).push(f);
    return () => this.off(k, f);
  }
  off<K extends keyof M>(k: K, f: Handler<M[K]>) {
    const a = this.h[k];
    if (a) this.h[k] = a.filter((x) => x !== f) as any;
  }
  emit<K extends keyof M>(k: K, e: M[K]) {
    const a = this.h[k];
    if (a) for (const f of a) f(e);
  }
}
