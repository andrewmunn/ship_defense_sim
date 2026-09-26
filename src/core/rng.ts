/** Small fast seeded PRNG (mulberry32). */
export class Rng {
  private s: number;
  constructor(seed = 1234567) {
    this.s = seed >>> 0;
  }
  /** Current position in the sequence; `seed(state)` resumes from it. */
  get state() {
    return this.s;
  }
  /** Restart the sequence from `seed` (repeatable runs, e.g. tools/balance.ts). */
  seed(seed: number) {
    this.s = seed >>> 0;
  }
  next() {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number) {
    return a + (b - a) * this.next();
  }
  int(a: number, b: number) {
    return Math.floor(this.range(a, b + 1));
  }
  gauss() {
    let u = 0, v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  pick<T>(a: T[]) {
    return a[Math.floor(this.next() * a.length)];
  }
  chance(p: number) {
    return this.next() < p;
  }
}
export const rng = new Rng((Date.now() & 0xffffff) ^ 0x5eed);
