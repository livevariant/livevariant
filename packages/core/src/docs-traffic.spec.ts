/**
 * Harness behind the skill's "Will this test ever finish?" table.
 * Two questions, one engine:
 *
 *  (1) DURATION: polling analyzeOutcomes like a dashboard does (every 250
 *      assignments), how many assignments until canStop first turns true,
 *      and how often is the arm it names actually the better one?
 *  (2) PAYOFF: over the SAME traffic, how many conversions does the
 *      adaptive allocation earn versus a frozen 50/50 split? Each
 *      visitor-count row stands alone — an n=2000 row is 200 runs of
 *      2,000 visitors, never 2,000 on top of a preceding 500.
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
 *   payoff, adaptive vs fixed 50/50 conversions (200 paired runs):
 *     5%/+25% n=2000 114.9 vs 111.6; n=10000 595.1 vs 561.6
 *     5%/+50% n=2000 135.7 vs 124.0; n=10000 718.5 vs 624.1
 * Medians move by a poll step or two between seed sets: an earlier run
 * with different seeds put 2%/+25% at 2250 rather than 3250. The payoff
 * figures above are the COMMON RANDOM NUMBERS version; an earlier
 * unpaired run of the same grid overstated the small-lift rows by up to
 * a point (2%/+25% at n=2000 read +2.4% unpaired against +1.2% paired),
 * which is why the pairing is worth its extra seed stream.
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

/**
 * One adaptive assignment: the real chooser, the real update.
 *
 * Assignment randomness and outcome randomness are separate streams so
 * that two allocation policies can be run over the SAME visitors. The
 * adaptive policy consumes many draws inside `choose` and a fixed split
 * consumes none, so one shared stream would hand the two policies
 * different coin flips and let that noise masquerade as an allocation
 * effect.
 */
function play(
  state: DerivedState,
  rates: readonly number[],
  assignRng: Rng,
  outcomeRng: Rng = assignRng
): boolean {
  const { cell, featIdx } = choose(state, [], assignRng);
  state.cells[cell].pulls += 1;
  observe(state.model, featIdx);
  const converted = outcomeRng() < rates[cell];
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
        // The quantiles below describe the runs that STOPPED. A run still
        // unresolved at CAP is censored: counted in the line, absent from
        // the quantiles, and so a censored row's median understates the
        // wait. Anything quoting this table must say the censored count.
        at.sort((x, y) => x - y);
        say(
          `base ${(base * 100).toFixed(0)}% lift +${(lift * 100).toFixed(0)}% | ` +
            `stopped ${stopped}/${RUNS} (censored ${RUNS - stopped}) | ` +
            `correct ${correct}/${RUNS} | ` +
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
        // Every visitor count is its own independent experiment: the
        // totals below are declared HERE, inside this loop, so an n=2000
        // row is 200 runs of 2,000 visitors and nothing else. Read the
        // scope carefully before quoting a row.
        for (const n of [500, 2000, 10_000]) {
          let adaptive = 0;
          let fixed = 0;
          const diffs: number[] = [];
          for (let s = 0; s < SIMS; s++) {
            // Common random numbers: both policies see the identical
            // sequence of per-visitor uniforms, so the only difference
            // between them is which arm each visitor was sent to.
            const stateA = fresh([2]);
            const assignRng = mulberry32(7000 + s * 11);
            const outcomeA = mulberry32(2000 + s * 53);
            let runAdaptive = 0;
            for (let t = 0; t < n; t++) {
              if (play(stateA, rates, assignRng, outcomeA)) runAdaptive++;
            }
            const outcomeF = mulberry32(2000 + s * 53);
            let runFixed = 0;
            for (let t = 0; t < n; t++) {
              if (outcomeF() < rates[t % 2]) runFixed++;
            }
            adaptive += runAdaptive;
            fixed += runFixed;
            // Paired difference for THIS pair of runs: with common random
            // numbers the pairing is real, so its spread is the honest
            // uncertainty on the gain.
            diffs.push(runAdaptive - runFixed);
          }
          const a = adaptive / SIMS;
          const f = fixed / SIMS;
          const mean = diffs.reduce((x, y) => x + y, 0) / SIMS;
          const variance =
            diffs.reduce((acc, d) => acc + (d - mean) ** 2, 0) / (SIMS - 1);
          const se = Math.sqrt(variance / SIMS);
          say(
            `base ${(base * 100).toFixed(0)}% lift +${(lift * 100).toFixed(0)}% ` +
              `n=${n}: adaptive ${a.toFixed(1)} vs fixed ${f.toFixed(1)} ` +
              `(${(((a - f) / f) * 100).toFixed(1)}%, ${(a - f).toFixed(1)} absolute, ` +
              `paired mean ${mean.toFixed(2)} +/- ${(2 * se).toFixed(2)})`
          );
        }
      }
    });
  }
);
