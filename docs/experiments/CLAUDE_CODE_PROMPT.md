# Claude Code task: A/B methods fixes from the statistical review

Paste the section below into Claude Code from the `livevariant` repo root.
Bluestars work is Task F and needs `~/sites/bluestars`.

Full findings, with measured numbers and literature: `docs/experiments/AB_TESTING_REVIEW.md`.
Every claim there was produced by porting this repo's own numerics to Python and
simulating them; the port is `docs/experiments/lv_port_reference.py` (reference
only — do not ship it).

---

## PROMPT STARTS HERE

Read `docs/experiments/AB_TESTING_REVIEW.md` first — it is a statistical audit of
this repo's A/B testing methods. Then work the tasks below.

Ground rules:

- The bandit itself is correct. Do **not** change `chooseCell`, the
  Sherman–Morrison update, the samplers in `rng.ts`, or the single-draw-per-serve
  behaviour. Serving is not what these tasks fix; **reporting** is.
- Every task is scoped to be independently shippable. Do them in order, one
  commit each, and stop after each so I can review.
- `packages/core` is consumed by `apps/web`, `packages/server`, `packages/sdk`,
  `packages/tools` and by the separate `bluestars` repo. Any exported-type change
  ripples — run `npm run build && npm test` before declaring a task done.
- Keep the house comment style: explain _why_, in prose, above the code.

### Task A — Fix the miscitation in `priors.ts` (smallest, do first)

`packages/core/src/priors.ts` lines 6-10 currently say:

> LLM warm-start priors. The literature's one hard lesson (warm-start
> bandits, Shivaswamy & Joachims 2012): priors must be weak enough for
> real data to override, so every prior is capped to priorStrengthCap
> pseudo-observations per variant before it touches the model.

That paper does not support that claim, and the review documents this in §2.4
with verbatim quotes. Shivaswamy & Joachims (2012) proves the _opposite_
direction — a logarithmic amount of historic data reduces regret from
logarithmic to constant, and regret tends to zero as history grows — under an
explicit assumption that _"The historic rewards for each arm are assumed to be
drawn independently from the same distributions as the non-historic rewards."_
An LLM's guessed conversion rate violates that assumption, which is exactly why
the cap is needed.

Rewrite the comment so that:

1. Shivaswamy & Joachims (2012) is cited for what it actually supports —
   warm-starting a bandit with history is sound and reduces regret.
2. The **cap** is grounded in prior _misspecification_, citing
   Loecher (2021), _The Perils of Misspecified Priors and Optional Stopping in
   Multi-Armed Bandits_, Frontiers in Artificial Intelligence 4:715690,
   doi:10.3389/frai.2021.715690.
3. Note that the cap's behaviour is measured, not assumed: an adversarial prior
   at the cap (wrong variant, mean 0.90, strength 50) delays finding the true
   winner from ~370 to ~472 visitors, and never prevented recovery in 30 runs.

Do not change `effectivePriors`' logic — the code is right, only the citation is
wrong.

### Task B — Correct the "collisions are rare" comments

Two comments overstate how well feature hashing is doing:

- `packages/core/src/model.ts:24` — "so collisions merge features instead of erroring"
- `packages/core/src/model.ts:126` — "(keeping hash collisions rare)"

Measured collision rates at shipped dimensions (review §3, finding 4): 26.7% of
features share a slot for `[3,3]` at dim 32; 41.7% for `[3,3]`+country; 55.6% for
`[2,2,2]`; 45.5% for the bluestars 8-segment shape.

Rewrite both comments to state the measured rate and the _real_ reason it is
tolerable — no shape tested produced same-slot main-effect aliasing (two variants
of one slot becoming indistinguishable), and the 3×3 local-optimum simulation
reaches the global optimum at dim 32, 64 and 128 alike. Cite Weinberger et al.
(2009), _Feature Hashing for Large Scale Multitask Learning_, ICML,
doi:10.1145/1553374.1553516, and note that `dimForShape`'s ~2× features-to-slots
ratio is well below the regime where that paper's guarantees apply.

No behaviour change in this task.

### Task C — Make `dimForShape` charge for context cardinality

This is the one finding with a real learning failure behind it, not just a
misleading comment.

`dimForShape(slotSizes, ctxDimCount)` in `packages/core/src/model.ts:130` charges
`ctxDimCount * (8 + mains)` — a flat cost per _dimension_, ignoring how many
values that dimension can take. Declaring `country` as a free-form dimension
therefore yields dim=32 for ~803 distinct features. Measured consequence: with
200 countries each having a genuinely different best variant, the model picks
correctly 36.3% of the time against a 33.3% chance baseline. It essentially
cannot learn per-segment winners in that configuration, and the 256 cap means no
setting fixes it.

Note the repo already has the information needed to detect this:
`SIGNAL_CARDINALITY` in `packages/core/src/signals.ts` lists `country: 200`,
`region: 3000`, `city: 10000`, `utm_term: 10000`.

Change `dimForShape` to charge for declared cardinality:

- when a `CtxDim` has a `values` array, use `values.length`;
- when it is signal-filled (`from`), use `SIGNAL_CARDINALITY[dim.from]`;
- otherwise keep a conservative default for free-form dimensions.

You will need to change the signature — it currently takes a count, and needs the
dimensions themselves. **Both call sites must stay in agreement or every record
is dropped by `safeFeatIdx`:** `packages/server/src/service.ts:95` and
`packages/sdk/src/index.ts:311`. `AssignmentRecord.dim` is stored per record and
`appliesTo`/`safeFeatIdx` in `state.ts` silently skip records whose dim disagrees,
so a mismatch is a silent data-loss bug, not a crash. Check whether existing
tests cover that path; add one if not.

Then decide, and write down in the comment which you chose and why: either raise
the 256 cap for high-cardinality contexts, or have `schema.ts` refuse (or warn on)
a dimension whose expected cardinality exceeds what the cap can represent — the
way it already refuses `cells > MAX_CELLS` at `schema.ts:254`. Refusing is
probably better than silently under-serving, but it is a product call: flag it for
me rather than guessing if you are unsure.

Add a test in `model.spec.ts` in the style of the existing ones: a
high-cardinality context test should either get a dimension proportional to its
cardinality, or be rejected at config time.

### Task D — Report ties instead of announcing a false leader

`decisionLine` in `packages/core/src/stats-derive.ts:104` says
`"<name> leads; stopping now risks under 1% of its rate"` whenever
`analysis.canStop`. Under continuous monitoring with two genuinely equal arms
(5% vs 5%), `canStop` fired in 109 of 150 runs and named the "wrong" arm in 54 of
them. Realized regret in those cases is exactly zero — expected loss is doing its
job, since with equal arms either choice is fine — but the _message_ asserts a
finding that does not exist.

Add a tie case. When the top arms' posteriors overlap enough that no leader is
distinguishable, say so ("no difference detected between X and Y — either is
safe to ship") rather than naming a leader. `analyzeOutcomes` already returns
`probabilities`, so a reasonable test is that no arm's `probabilityBest` clears a
modest margin over the runner-up; put the threshold next to `MIN_PULLS_TO_CALL`
in `decide.ts` as a named export with a comment, not a bare literal in the string
builder.

Also fix the promise itself. The review measured realized regret of **2.59% of
the best rate** against the advertised 1% in the small-lift case (5% vs 6%),
because the rule controls posterior expected loss _at a single look_ while the
product polls continuously until it fires. Either soften the wording so it no
longer promises a bound that repeated evaluation breaks, or document `canStop`
explicitly as a per-look quantity in the `DecisionAnalysis` doc comment. Cite
Johari, Koomen, Pekelis & Walsh (2022), _Always Valid Inference: Continuous
Monitoring of A/B Tests_, Operations Research 70(3), doi:10.1287/opre.2021.2135,
and Loecher (2021) as above.

Do not change the `canStop` threshold's value in this task — wording and
documentation only. Changing the statistics is Task G.

### Task E — Gate per-segment winners on exposure

`summarizeBuckets` in `packages/core/src/stats-derive.ts` runs an independent
`analyzeOutcomes` per context bucket and returns each bucket's leader with its
`probabilityBest`, with no multiplicity control. Measured with every segment and
variant given an identical 5% true rate: at 8 segments × 2 variants, **52.7% of
runs display at least one segment with P(best) ≥ 95%** — a false winner. At 4
segments it is 30.7%; at 12 segments × 3 variants, 20.0%.

This is the product's headline claim ("a different winner per audience"), so a
false per-segment winner is the feature appearing to work when it isn't.

Add a minimum-exposure gate before a bucket is allowed to report a leader.
`summarizeBuckets` already ranks buckets by total pulls, so the gate is one
comparison. Buckets below it should still appear with their counts — just
without a leader or a confidence figure, the way `MIN_PULLS_TO_CALL` suppresses a
call on thin data for the whole test. Export the constant with a comment
explaining the false-discovery measurement above.

Then flag for me (do not implement yet) what the review recommends as the real
fix: the joint model already carries both a global main effect and a
`(context × variant)` interaction per variant, so a bucket's displayed estimate
could be shrunk toward the global one — reporting the model's posterior per
segment rather than a fresh independent analysis of that bucket's raw counts.
That is a hierarchical/partial-pooling approach (Gelman, Hill & Yajima 2012,
doi:10.1080/19345747.2011.618213) and a bigger change than this task. Write it up
as a follow-up issue with your assessment of the work involved.

### Task F — Bluestars (separate repo: `~/sites/bluestars`)

Bluestars is implementing the engine **correctly** — it imports core's arithmetic
rather than re-deriving it, which is the right call and should not change. Two
things to do there:

1. It runs the configuration most exposed to Task E: the BSR8 pack means up to 8
   colour segments against 2–4 image variants, which is exactly the 52.7% cell.
   Once Task E ships, bump the `@livevariant/*` dependency and confirm the gate
   takes effect in `apps/sdk/app/tenant/[slug]/studio/_lib/TestResults.tsx`
   (which renders `results.buckets.top`) and in the stats route at
   `apps/sdk/app/api/tenants/[id]/experiments/[testId]/stats/route.ts` (which
   calls `summarizeBuckets(stats, 6)`).
2. `apps/sdk/src/lib/livevariant/ctx-resolvers.ts` documents that a recipient
   whose first fetch fails to resolve stays unbucketed for the life of the test,
   because assignment is sticky. There is currently no visibility into how often
   that happens. Add a counter or log line so an unusual unbucketed share in a
   send is detectable — if a large fraction of a campaign failed to resolve, that
   campaign's segment analysis is reporting on a non-random subset of recipients.

### Task G — Documentation and the honest-trade framing (do last)

1. `README.md:225` cites "the published literature (Thompson 1933; Chapelle & Li
   2011; Li et al. 2010; Hill et al., KDD 2017; Shivaswamy & Joachims 2012)".
   All five are real papers — verified against Crossref, arXiv and dblp — and
   four map cleanly to code that implements them. Fix the fifth per Task A.
2. The same README paragraph argues against the classic email flow. The critique
   is fair, but it presents the trade as free. Adaptive allocation buys lower
   regret and pays in inferential precision: the starved arm's reported rate is
   biased low by ~11% of its true value (review finding 1), and any repeatedly
   evaluated stopping rule loses its nominal guarantee (finding 2). Add a short,
   non-defensive sentence or two making that explicit — LiveVariant optimizes
   earnings-while-learning rather than measurement precision, which is the right
   trade for a campaign whose goal is conversions. This strengthens the pitch and
   sets accurate expectations for the number a customer reads off the dashboard.
3. Add an inference section to `CLAUDE.md` recording the four findings and their
   grounding, so the next person to touch `decide.ts` or `stats-derive.ts` finds
   the reasoning instead of rediscovering it. The review's §5 table is the
   source; every reference in it has a verified DOI or arXiv id.

### Not in scope

Finding 1 (adaptive-allocation bias in the reported rates) is deliberately left
out of these tasks. The honest fix is either a clear exposure warning on
thin-exposure variants, or the adaptively-weighted AIPW estimator of Hadad,
Hirshberg, Zhan, Wager & Athey (2021), PNAS 118(15),
doi:10.1073/pnas.2014602118, computed over the existing event log — which is
feasible, since `AssignmentRecord` retains per-record `firstSeen` and `featIdx`,
but is a design decision rather than a cleanup. Do **not** simply widen the
Wilson interval: that repairs coverage while leaving the point estimate wrong.
Read review §3 finding 1 and give me a recommendation with a rough estimate,
without writing the implementation.

## PROMPT ENDS HERE
