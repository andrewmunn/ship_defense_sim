import { SIM_DT } from './constants';

/** Retains fractional steps and budget-limited backlog across rendered frames. */
export class SimClock {
  private pending = 0;

  get alpha() {
    return Math.min(1, this.pending / SIM_DT);
  }

  reset() {
    this.pending = 0;
  }

  advance(elapsed: number, step: (dt: number) => void, overBudget = () => false, maxSteps = 64) {
    if (!Number.isFinite(elapsed) || elapsed < 0) return 0;
    this.pending += elapsed;
    let steps = 0;
    while (this.pending + 1e-10 >= SIM_DT && steps < maxSteps) {
      step(SIM_DT);
      this.pending = Math.max(0, this.pending - SIM_DT);
      steps++;
      if (overBudget()) break;
    }
    return steps * SIM_DT;
  }
}
