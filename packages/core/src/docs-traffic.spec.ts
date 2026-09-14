/**
 * Harness behind the skill's "Will this test ever finish?" table.
 * Two questions, one engine:
 *
 *  (1) DURATION: polling analyzeOutcomes like a dashboard does (every 250
 *      assignments), how many assignments until canStop first turns true,
 *      and how often is the arm it names actually the better one?
 *  (2) PAYOFF: over the SAME traffic, how many conversions does the
 *      adaptive allocation earn versus a frozen 50/50 split?
 *
 * Nothing here is mocked: choose/observe/reward is the shipped model and
 * analyzeOutcomes is the shipped decision. Results are appended to a file
 * because nx swallows stdout.
 *
 * It takes about nine minutes, so it does not run in CI:
 *   LV_SIMS=1 npx nx test @livevariant/core --skip-nx-cache -- --run docs-traffic
 *
 * Numbers published in the skill, from the run of 2026-09-14:
 *   duration, median assignments to the first canStop (60 runs, right/60):
 *     2%/+10% 3750 (44)   2%/+25% 3250 (55)   2%/+50% 1500 (60)
 *     5%/+10% 2250 (46)   5%/+25% 1250 (59)   5%/+50%  750 (60)
 *    10%/+10% 1500 (51)  10%/+25% 1000 (58)  10%/+50%  500 (60)
 *   payoff, adaptive vs fixed 50/50 conversions (200 runs):
 *     5%/+25% n=2000 115.7 vs 111.6; n=10000 594.0 vs 561.6
 *     5%/+50% n=2000 137.2 vs 124.0; n=10000 718.6 vs 624.1
 * Medians move by a poll step or two between seed sets: an earlier run
 * with different seeds put 2%/+25% at 2250 rather than 3250, and every
 * payoff figure within 0.3 points of the above.
 */
import { appendFileSync } from "node:fs";
import { describe, it, vi } from "vitest";
import { analyzeOutcomes } from "./decide.js";
import { dimForShape, observe, reward } from "./model.js";
import { mulberry32, type Rng } from "./rng.js";
import { choose, newDerivedState, type DerivedState } from "./state.js";

const OUT = "/tmp/traffic.txt";
const say = (line: string) => appendFileSync(OUT, line + "\n");

vi.setConfig({ testTimeout: 1_800_000 });

function fresh(slotSizes: number[]): DerivedState {
  return newDerivedState({ dim: dimForShape(slotSizes), slotSizes });
}

/** One adaptive assignment: the real chooser, the real update. */
function play(
  state: DerivedState,
  rates: readonly number[],
  rng: Rng
): boolean {
  const { cell, featIdx } = choose(state, [], rng);
  state.cells[cell].pulls += 1;
  observe(state.model, featIdx);
  const converted = rng() < rates[cell];
  if (converted) {
    state.cells[cell].successes += 1;
    reward(state.model, featIdx);
  }
  return converted;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

const RUNS = 60;
const EVERY = 250;
const CAP = 60_000;

const GRID = [
  [0.02, 0.1],
  [0.02, 0.25],
  [0.02, 0.5],
  [0.05, 0.1],
  [0.05, 0.25],
  [0.05, 0.5],
  [0.1, 0.1],
  [0.1, 0.25],
  [0.1, 0.5]
] as const;

describe.skipIf(!process.env.LV_SIMS)(
  "how long a test takes and what the wait earns",
  () => {
    it("duration to first canStop, and whether the named leader is right", () => {
      say(`--- DURATION (runs=${RUNS} poll=${EVERY} cap=${CAP}) ---`);
      for (const [base, lift] of GRID) {
        const rates = [base, base * (1 + lift)];
        let stopped = 0;
        let correct = 0;
        const at: number[] = [];
        for (let s = 0; s < RUNS; s++) {
          const rng = mulberry32(1000 + s * 37);
          const state = fresh([2]);
          for (let t = 1; t <= CAP; t++) {
            play(state, rates, rng);
            if (t % EVERY !== 0) continue;
            const arms = state.cells.map(c => ({
              pulls: c.pulls,
              conversions: c.successes
            }));
            const a = analyzeOutcomes(arms, {
              rng: mulberry32(0x5eed),
              draws: 8000
            });
            if (!a.canStop) continue;
            stopped++;
            at.push(t);
            if (a.leader === 1) correct++;
            break;
          }
        }
        at.sort((x, y) => x - y);
        say(
          `base ${(base * 100).toFixed(0)}% lift +${(lift * 100).toFixed(0)}% | ` +
            `stopped ${stopped}/${RUNS} | correct ${correct}/${RUNS} | ` +
            `median ${quantile(at, 0.5)} | p25 ${quantile(at, 0.25)} | ` +
            `p75 ${quantile(at, 0.75)}`
        );
      }
    });

    it("adaptive allocation versus a frozen 50/50 split over the same traffic", () => {
      const SIMS = 200;
      say(`--- PAYOFF (sims=${SIMS}) ---`);
      for (const [base, lift] of GRID) {
        const rates = [base, base * (1 + lift)];
        for (const n of [500, 2000, 10_000]) {
          let adaptive = 0;
          let fixed = 0;
          for (let s = 0; s < SIMS; s++) {
            const stateA = fresh([2]);
            const rngA = mulberry32(2000 + s * 53);
            for (let t = 0; t < n; t++)
              if (play(stateA, rates, rngA)) adaptive++;
            // The same visitors, split evenly and never reallocated.
            const rngF = mulberry32(2000 + s * 53);
            for (let t = 0; t < n; t++) {
              const cell = t % 2;
              if (rngF() < rates[cell]) fixed++;
            }
          }
          const a = adaptive / SIMS;
          const f = fixed / SIMS;
          say(
            `base ${(base * 100).toFixed(0)}% lift +${(lift * 100).toFixed(0)}% ` +
              `n=${n}: adaptive ${a.toFixed(1)} vs fixed ${f.toFixed(1)} ` +
              `(${(((a - f) / f) * 100).toFixed(1)}%, ${(a - f).toFixed(1)} absolute)`
          );
        }
      }
    });
  }
);
