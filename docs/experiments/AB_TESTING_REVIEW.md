# A/B Testing Methods Review — LiveVariant & Bluestars

Audit of the statistical methods shipped in `~/sites/livevariant` (the engine)
and `~/sites/bluestars` (a consumer of it), with each design decision traced to
the research literature that supports or contradicts it.

**Method.** LiveVariant's numerics were ported line-for-line from
`packages/core/src` to Python (`lv_port.py`) so the audit measures the shipped
arithmetic rather than a paraphrase of it: `fnv1a32`, `dimForShape`,
`cellFeatures`, `newModel`/`observe`/`reward`/`chooseCell` (Sherman–Morrison +
Cholesky), the mulberry32/Box–Muller/Marsaglia–Tsang samplers, `analyzeOutcomes`
and `wilson95`. The port reproduces the repo's own `model.spec.ts` assertions
before any conclusion is drawn from it (`dimForShape([2])==16`; late-winner share
0.971 > 0.85; cumulative conversion 0.0985 > 0.08). Every number below is a
simulation output, not an estimate.

---

## 1. Verdict

The engineering is unusually disciplined and the core algorithm choice is sound
and correctly implemented. Thompson sampling is drawn once per serve and every
cell scored against that single draw — the detail that preserves
probability-matching and the one most implementations get wrong. The joint model
genuinely solves the interaction problem it claims to: on the repo's own
adversarial 3×3 matrix, where both marginals point into a local-optimum basin,
the model reaches the global optimum `(v3,v3)` in 92–95% of late traffic.

Four findings need attention. Ranked by expected harm:

| #   | Finding                                                                                                                                                | Severity | Where                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ----------------------------------------------- |
| 1   | Reported rate of a starved variant is biased low by ~11% of its true value; Wilson intervals are frequentist intervals over adaptively collected data  | **High** | `stats-derive.ts:wilson95`, all result surfaces |
| 2   | `canStop` fires on genuine ties (73% of null runs) and its 1% regret promise is violated in the small-lift case (realized 2.6%)                        | **High** | `decide.ts:analyzeOutcomes`                     |
| 3   | Per-segment "winner" display has an uncontrolled false-discovery rate: 53% at 8 segments × 2 variants                                                  | **High** | `stats-derive.ts:summarizeBuckets`              |
| 4   | Feature hash collisions are described as "rare" but affect 25–56% of features at shipped dimensions; a 200-value context dimension cannot learn at all | Medium   | `model.ts:dimForShape`                          |

Bluestars is implementing the engine **correctly** — it imports the arithmetic
rather than re-deriving it, which is exactly right. But it selects the
configuration that maximizes exposure to findings 1 and 3.

---

## 2. What the code gets right

### 2.1 One Thompson draw per serve, not per arm

`model.ts:chooseCell` samples `theta` once and scores every cell against that
same draw. The comment states the reason correctly: per-cell sampling would
break probability matching. This is the foundational result of
Thompson (1933), given its modern empirical justification by
Chapelle & Li (2011), _An Empirical Evaluation of Thompson Sampling_ (NIPS 24),
and its first rigorous regret guarantees by Agrawal & Goyal (2012/2013),
_Analysis of Thompson Sampling for the Multi-armed Bandit Problem_ (COLT) and
_Thompson Sampling for Contextual Bandits with Linear Payoffs_ (ICML).
The linear-payoff structure with a per-serve posterior draw over
`theta ~ N(theta_hat, noise^2 * A^-1)` is exactly the Agrawal & Goyal
formulation. Correctly cited in the README.

### 2.2 The joint model earns its complexity

The claim that per-slot testing structurally cannot find interaction effects is
correct and the test that demonstrates it is honest — the comment in
`model.spec.ts` even explains why a 2×2 would be too easy (independent bandits
perform coordinate ascent and escape), so it uses a 3×3 with a real basin. This
is the multivariate-testing argument from Hill et al. (KDD 2017),
_An Efficient Bandit Algorithm for Realtime Multivariate Optimization_, which
reports a 21% conversion increase **relative to the median layout** after one
week of online optimization at Amazon (verified against the paper's text: the
comparison base is the median layout, not sequential per-element testing).
Correctly cited. My replication confirms the mechanism works at every dimension tested
(32/64/128), so the collision issue in finding 4 does **not** undermine this
claim.

### 2.3 Wilson over the normal approximation

`stats-derive.ts:wilson95` chooses the Wilson score interval and the comment
gives the right reason: small n and rates near zero are exactly where the Wald
interval fails. This follows Wilson (1927) and the definitive comparison in
Brown, Cai & DasGupta (2001), _Interval Estimation for a Binomial Proportion_
(Statistical Science), which recommends Wilson for n < 40 and shows the Wald
interval's coverage collapses near p = 0. The right choice — see finding 1 for
the caveat that no choice of interval addresses.

### 2.4 Priors capped so data can override

`priors.ts` cites Shivaswamy & Joachims (2012), _Multi-armed Bandit Problems
with History_ (AISTATS), for the rule that "priors must be weak enough for real
data to override", and caps every prior at `priorStrengthCap` (default 50)
pseudo-observations.

**The cap is the right behaviour, but the citation does not support it.** Having
now read the paper (verified via dblp → PMLR, see Appendix A), its result is the
_opposite_ directionally: it proves that a **logarithmic amount of historic data
reduces regret from logarithmic to constant**, and that "as the number of
historic observations for every arm tends to infintiy [sic], the regret achieved
is zero" — i.e. more history is monotonically better. The reason is an explicit
assumption stated in the paper: _"The historic rewards for each arm are assumed
to be drawn independently from the same distributions as the non-historic
rewards."_ The paper is about **correct** history, and it says nothing about
capping a possibly-wrong belief. It even notes that "no amount of historic data
can help in the adversarial setting".

An LLM's guess at a conversion rate is precisely history that may **not** come
from the reward distribution, so the paper's assumption is violated in the use
case `priors.ts` invokes it for. The capping decision is defensible on its own
merits — and §3's simulation below independently confirms it works — but its
grounding is _prior misspecification_, not this paper. Loecher (2021), already
cited for finding 2, is the apt reference: its title is _The Perils of
**Misspecified Priors** and Optional Stopping in Multi-Armed Bandits_.

**My simulation confirms the cap's behaviour regardless of the citation.** A maximally adversarial prior (wrong variant, mean 0.90, strength 50 —
an 18× overstatement on the wrong arm) delays finding the true winner from 370
to 472 visitors, a 28% delay, and 0 of 30 runs failed to recover. The comment's
"costs a little early traffic, never the test" is accurate. Bluestars'
`RENDITION_PRIOR_STRENGTH = 10` is comfortably conservative.

### 2.5 Expected loss instead of p-values

`decide.ts` reports expected loss (`E[max_j rate_j - rate_leader]`) rather than
a p-value, and the comment defends it as answering "how much could this decision
cost me". This is the value-remaining stopping rule from Scott (2010), _A Modern
Bayesian Look at the Multi-armed Bandit_ (Applied Stochastic Models in Business
and Industry) — the method behind Google Analytics Content Experiments — and
Scott (2015), _Multi-armed Bandit Experiments in the Online Service Economy_.
The 1% convention matches Scott's. Right framework; see finding 2 for the
threshold's behaviour in practice.

### 2.6 Event sourcing, determinism, and exclusions

`state.ts` + `exclusions.ts` make derived state a pure function of an event log,
so exclusions heal history rather than only affecting new traffic, and
`recompute.spec.ts` asserts incremental and replay paths agree. `applyExclusions`
is deliberately manual, and the comment's reasoning is correct: mail providers
fetch images through shared infrastructure, so any automatic IP rule would
discard most of a legitimate send. This is the outlier/bot-filtering problem
described in Kohavi, Tang & Xu (2020), _Trustworthy Online Controlled
Experiments_, and refusing to automate it is the defensible call.

Seeding `analyzeOutcomes` with a fixed default (`0x5eed`) so the same stats
explain the same way twice is a good decision that most implementations miss.

---

## 3. Findings

### Finding 1 — Adaptive allocation biases the reported rates (High)

**What the code does.** `wilson95` computes a frequentist score interval from
`(conversions, pulls)`, and every surface renders it: the engine's `StatsPanel`
("95% interval" column) and bluestars' `TestResults`. `VariantStats.conversionRate`
is the raw ratio `conversions / pulls`.

**The problem.** Those counts were not collected under a fixed design. Thompson
sampling allocates on the basis of interim outcomes, which makes the sample mean
a biased estimator of the true rate. The direction is not random: an arm that
gets an unlucky early run is sampled less, so its poor estimate is frozen in
with few observations to correct it.

**Measured** (300 replications × 1500 visitors, true rates 5% vs 10%, their
chooser):

|                               | losing variant                | winning variant |
| ----------------------------- | ----------------------------- | --------------- |
| bias, adaptive                | **−0.00541** (−10.8% of true) | +0.00012        |
| bias, frozen 50/50            | +0.00030 (+0.6%)              | −0.00166        |
| Wilson 95% coverage, adaptive | 0.947                         | 0.940           |
| Wilson coverage, frozen       | 0.947                         | 0.960           |
| mean pulls                    | 254.7                         | 1245.3          |

Under the null (5% vs 5%) both arms are biased low: −0.00179 and −0.00148, with
coverage 0.940/0.947 against a nominal 0.95.

So the loser's conversion rate is **understated by about a tenth of its own
value**, and interval coverage degrades mildly. A customer comparing "4.5% vs
10%" is reading a gap that is really 5% vs 10%.

**Literature.** This is a well-characterized phenomenon, not an implementation
bug. Nie, Tian, Taylor & Zou (2018), _Why Adaptively Collected Data Have
Negative Bias and How to Correct for It_ (AISTATS), prove the sample mean of an
adaptively sampled arm is negatively biased under conditions that
"optimism-driven" algorithms including Thompson sampling satisfy. Shin, Ramdas &
Rinaldo (2019), _Are Sample Means in Multi-Armed Bandits Positively or
Negatively Biased?_ (NeurIPS), characterize the sign per-arm. The correction
literature is mature: Hadad, Hirshberg, Zhan, Wager & Athey (2021), _Confidence
Intervals for Policy Evaluation in Adaptive Experiments_ (PNAS 118(15)), give
adaptively-weighted augmented-IPW estimators with valid coverage; Zhang, Janson
& Murphy (2020), _Inference for Batched Bandits_ (arXiv:2002.03217), give the
batched-bandit analogue.

Note this is a _reporting_ problem, not a serving problem. The bandit itself is
performing correctly — it is supposed to starve the loser. The defect is that
the dashboard presents adaptively-collected counts with the visual grammar
(point estimate + 95% interval) of a fixed-design experiment.

**Recommendation.** Cheapest honest fix: label the interval for what it is and
show the exposure that produced it. `stats-derive.ts` already computes
`share`, so a variant whose share has collapsed can carry a marker ("thin
exposure — rate biased low"). If a defensible number is wanted, the
Hadad et al. adaptively-weighted estimator is implementable over the existing
event log, since `AssignmentRecord` retains per-record `firstSeen` and
`featIdx`; that is the only path to an interval that means what it appears to
mean. Do **not** simply widen the Wilson interval — that fixes coverage while
leaving the point estimate wrong.

### Finding 2 — The stopping rule fires on ties and overruns its own promise (High)

**What the code does.** `analyzeOutcomes` sets `canStop` when
`relativeLoss <= threshold` (default 1%) and at least one arm has ≥
`MIN_PULLS_TO_CALL` (100) pulls. `decisionLine` renders this as "stopping now
risks under 1% of its rate". Both the dashboard and the MCP `get_stats` advice
read it, and both poll continuously.

**Measured** (150 replications, checking every 25 visitors up to 3000 — the
continuous-monitoring pattern the product actually invites):

| scenario                        | fired   | correct | wrong  | never fired | median n at stop |
| ------------------------------- | ------- | ------- | ------ | ----------- | ---------------- |
| no real difference (5%, 5%)     | 109/150 | 55      | 54     | 41          | 700              |
| small lift (5%, 6%)             | 116/150 | 98      | **18** | 34          | 775              |
| clear winner (5%, 10%)          | 150/150 | 150     | 0      | 0           | 275              |
| 3 arms, tie at top (5%, 8%, 8%) | 103/150 | 54      | 49     | 47          | 1150             |

Two distinct issues:

**(a) Firing on ties is mostly benign but the message is wrong.** In the null
case 54 of 109 stops picked the "wrong" arm — but both arms are identical, so
realized regret is exactly 0. Bayesian expected loss is doing its job: when arms
are equivalent, either choice is fine. The defect is communicative — `decisionLine`
announces a leader and implies a finding where there is none. A tie is a real
result and should be reported as one.

**(b) The 1% promise is genuinely violated in the small-lift case.** This is the
substantive failure. Realized mean regret was **2.59% of the best rate** against
a promised 1%, because the 18 wrong calls each cost 16.7% of the best rate. The
rule controls _posterior expected_ loss at a single look; evaluated repeatedly
until it fires, the realized error rate is not the nominal one.

**Literature.** This is optional stopping / the peeking problem, and it applies
to Bayesian rules too. Johari, Koomen, Pekelis & Walsh (2017), _Peeking at A/B
Tests: Why It Matters, and What to Do About It_ (KDD), and the journal version
_Always Valid Inference: Continuous Monitoring of A/B Tests_
(Operations Research 70(3), 2022), show continuous monitoring inflates error
rates substantially above the nominal level and give always-valid sequential
p-values and confidence sequences as the fix. (I did not verify their specific
inflation multiplier; the effect direction is what my own measurement above
demonstrates independently.) Specifically for bandits, Loecher (2021), _The Perils of
Misspecified Priors and Optional Stopping in Multi-Armed Bandits_
(Frontiers in Artificial Intelligence 4:715690), demonstrates that Bayesian
bandit stopping rules are susceptible to peeking — directly on point.
Modern anytime-valid alternatives: Howard, Ramdas, McAuliffe & Sekhon (2021),
_Time-uniform, Nonparametric, Nonasymptotic Confidence Sequences_
(Annals of Statistics 49(2), doi:10.1214/20-aos1991).

**Recommendation.** Three options, cheapest first. (i) Report ties explicitly:
when the top arms' posteriors overlap substantially, `decisionLine` should say
"no difference detected" rather than naming a leader — this fixes issue (a)
with a text change. (ii) Document `canStop` as a per-look quantity and make the
threshold reflect monitoring frequency. (iii) For a defensible guarantee,
replace the fixed threshold with a confidence sequence (Howard et al.) or an
always-valid p-value (Johari et al.) — the only option that makes the stated
promise true under continuous polling.

### Finding 3 — Per-segment winners have an uncontrolled false-discovery rate (High)

**What the code does.** `summarizeBuckets` runs an independent `analyzeOutcomes`
on every context bucket (4000 draws each) and returns each bucket's leader with
its `probabilityBest`. The engine's `StatsPanel` and bluestars'
`TestResults` render one row per segment with a per-segment winner. No
multiplicity adjustment anywhere.

**Measured** — all segments and all variants given the _same_ true rate of 5%,
asking how often at least one segment displays `P(best) >= 95%`:

| segments × variants | visitors/segment | runs with ≥1 false winner | median max P(best) |
| ------------------- | ---------------- | ------------------------- | ------------------ |
| 1 × 2               | 400              | 12.7%                     | 0.751              |
| 4 × 2               | 400              | 30.7%                     | 0.918              |
| **8 × 2**           | 400              | **52.7%**                 | **0.955**          |
| 12 × 3              | 300              | 20.0%                     | 0.898              |
| 8 × 4               | 400              | 6.7%                      | 0.774              |
| 8 × 8               | 400              | 0.0%                      | 0.619              |

With 8 segments and 2 variants, **a coin-flip chance that the dashboard shows a
confident segment winner that does not exist.** (The rate falls at 4 and 8
variants because per-arm counts thin out and no arm reaches confidence — a
sample-size artifact, not safety.)

This is the product's headline claim — "learns a different winner per audience"
— so a false per-segment winner is not a cosmetic issue; it is the feature
appearing to work when it isn't.

**Literature.** Classical multiplicity: Benjamini & Hochberg (1995) for FDR
control, and in the experimentation context Deng, Lu & Litz (2017),
_Trustworthy Analysis of Online A/B Tests: Pitfalls, Challenges and Solutions_
(WSDM), plus Kohavi, Tang & Xu (2020) ch. 17 on segment-level analysis, which
names exactly this failure. For the Bayesian framing, Gelman, Hill & Yajima
(2012), _Why We (Usually) Don't Have to Worry About Multiple Comparisons_
(Journal of Research on Educational Effectiveness), argue the right fix is a
hierarchical/partially-pooled model that shrinks segment effects toward the
global effect rather than a post-hoc correction — which fits this architecture
well, since the joint linear model already has global main effects for exactly
these variants.

**Recommendation.** The model already contains the right structure: a segment's
`(context × variant)` interaction and the variant's global main effect.
Shrinking a bucket's displayed estimate toward the global one — i.e. reporting
the _posterior_ per segment rather than a fresh independent analysis of the
bucket's raw counts — would suppress most of these false winners. Failing that,
require a minimum per-bucket exposure before showing a leader (`summarizeBuckets`
already ranks by pulls, so the gate is one comparison), and report per-segment
claims as exploratory.

### Finding 4 — Hash collisions are not "rare" (Medium)

**What the code does.** `dimForShape` sizes the feature space to roughly twice
the number of expressible features, rounds to a power of two, and clamps at 256.
Comments in `model.ts` and `context.ts` say collisions are "rare" and that
merging is tolerable.

**Measured** — enumerating every feature name a shape can express and hashing it
the way `cellFeatures` does:

| shape                          | dim | features | features sharing a slot |
| ------------------------------ | --- | -------- | ----------------------- |
| plain A/B `[2]`                | 16  | 2        | 0%                      |
| A/B/C `[3]`                    | 16  | 3        | 0%                      |
| 2 slots `[3,3]`                | 32  | 15       | 26.7%                   |
| `[3,3]` + country (3 values)   | 64  | 36       | 41.7%                   |
| bsr8 colour `[4]` + 8 segments | 64  | 44       | 45.5%                   |
| `[2,2,2]`                      | 64  | 18       | 55.6%                   |
| `[4,4]` + device               | 128 | 51       | 41.2%                   |
| `[3]` + country (200 values)   | 32  | 803      | 100%                    |

**Severity is lower than those numbers suggest**, and this deserves saying
plainly: no shape tested produced _same-slot_ main-effect aliasing (two variants
of one slot becoming indistinguishable), which would be the damaging case. The
collisions are mostly main-effect-with-interaction and cross-slot merges, which
a linear model absorbs. The 3×3 trap simulation confirms it: dim 32, 64 and 128
all reach the global optimum at 0.92–0.95 late share, and the shipped dim=32 was
best. **So the "collisions merge features instead of erroring" defence holds in
practice for reasonable shapes** — but the word "rare" is wrong, and the margin
is thinner than the code implies.

**The real problem is high-cardinality context.** `signals.ts` ships a
`SIGNAL_CARDINALITY` table listing `country: 200`, `region: 3000`,
`city: 10000`, `utm_term: 10000` — and `dimForShape` charges only
`ctxDimCount * (8 + mains)` per dimension, so declaring `country` as a
free-form dimension yields dim=32 for 803 features. Measured, with each of 200
countries given its own true best variant:

| dim              | correct per-segment pick |
| ---------------- | ------------------------ |
| **32 (shipped)** | **0.363**                |
| 64               | 0.374                    |
| 128              | 0.363                    |
| 256              | 0.417                    |

Chance is 0.333. The model is barely above a context-blind one, and the 256 cap
means no configuration fixes it. `normalizeCtx` caps free-form values at 64
characters but not in _count_, so this is reachable: a `country` dimension
without a declared `values` list, which is the natural thing to write.

Note the collision-rate table above understates high-cardinality damage in one
way worth flagging: `enumerateBucketLabels` gives up past
`MAX_LABEL_CANDIDATES = 1024`, so precisely the tests most affected also lose
their readable bucket labels.

**Literature.** The hashing trick is from Weinberger, Dasgupta, Langford, Smola
& Attenberg (2009), _Feature Hashing for Large Scale Multitask Learning_ (ICML),
whose guarantees are asymptotic in the ratio of hash size to feature count —
`dimForShape`'s 2× is far below the regime where those bounds bite. The repo's
own `SIGNAL_CARDINALITY` table already contains the information needed to detect
this.

**Recommendation.** Make `dimForShape` charge for _declared cardinality_ rather
than dimension count — the `values` list length when present, and
`SIGNAL_CARDINALITY[dim.from]` when the dimension is signal-filled. Then either
raise the 256 cap for high-cardinality contexts or have `schema.ts` refuse (or
warn on) a free-form dimension whose expected cardinality exceeds what the cap
can represent, the way it already refuses `cells > MAX_CELLS`. Correct the
"rare" comments to state the measured rate and the reason it is tolerable
(no same-slot aliasing) rather than asserting rarity.

---

## 4. Bluestars: is the engine used correctly?

**Yes, with one architectural caveat that is the engine's rather than
bluestars'.**

What is right:

- **No re-derived statistics.** `apps/sdk/src/lib/livevariant/stats.ts` and the
  experiments stats route import `analyzeCombinations`, `analyzeSlots`,
  `decisionLine` and `summarizeBuckets` from `@livevariant/core`. A grep for
  hand-rolled p-values, z-scores, `1.96`, or chi-square in the bluestars app
  found nothing. `TestResults.tsx` renders `probabilityBest` and `canStop`
  without inventing its own thresholds. This is the single most important thing
  to get right in a consumer and they got it right — the comment in `stats.ts`
  ("The arithmetic on top of the payload is not ours to invent either") states
  the principle explicitly.
- **Priors are conservative.** `RENDITION_PRIOR_STRENGTH = 10` against the
  engine's cap of 50, with a documented rationale for using the same strength in
  every mode. My simulation supports this: even adversarial priors at strength
  50 cost only ~28% delay.
- **The `bsr-color` resolver is carefully reasoned.** The four documented
  behaviours in `ctx-resolvers.ts` are correct, and rule 4 in particular —
  refusing to fall back to IP geolocation when `networkSignalsSuppressed` is set
  — identifies a real and serious failure mode. Because assignment is sticky, an
  IP fallback on an email image fetch would permanently bucket an entire campaign
  into whichever datacenter Gmail geolocates to. Failing to an _absent_
  dimension is the right call, and the module states the cost honestly.
- **Secret handling.** The stats secret never reaches a browser; reads happen
  server-side over an internal actor token with `lock_reads` on.

What to watch:

1. **Bluestars runs the configuration most exposed to findings 1 and 3.** The
   BSR8 pack means up to 8 colour segments, and the newsletter tests typically
   run 2–4 image variants. That is the 8×2 cell measured at a **52.7%** false
   per-segment-winner rate. Combined with email traffic — where a campaign
   delivers a large burst and then goes quiet, so buckets stay thin — the
   per-segment display is the highest-risk surface in either repo. Gate
   per-segment leaders on minimum bucket exposure before showing them to
   tenants.
2. **Sticky assignment plus resolver failure is unrecoverable per recipient.**
   `ctx-resolvers.ts` documents this ("a recipient whose FIRST fetch failed to
   resolve stays unbucketed for the life of the test"). Worth a monitored
   counter: if an unusual share of a send lands unbucketed, the segment analysis
   for that campaign is reporting on a non-random subset.
3. **`decisionLine` reaches tenants.** Since it can announce a leader on tied
   arms (finding 2a), and the audience here is marketers rather than
   statisticians, the tie-reporting fix matters more in bluestars than on
   livevariant.com.
4. **No sample-ratio check.** Neither repo implements an SRM test. In this
   architecture allocation is _deliberately_ unequal, so a classic SRM check
   does not apply to variant shares — but the engine's own quarantine workflow
   exists because unauthenticated writes can be flooded, and an automated
   alarm on the `perSource` distribution would catch that earlier than a human
   scanning the breakdown. Fabijan et al. (2019), _Diagnosing Sample Ratio
   Mismatch in Online Controlled Experiments_ (KDD), is the reference for the
   general technique.

---

## 5. Grounding notes: methods → literature

For `CLAUDE.md` / `DESIGN.md`. The README's existing citation list
(Thompson 1933; Chapelle & Li 2011; Li et al. 2010; Hill et al. KDD 2017;
Shivaswamy & Joachims 2012) all resolve to real papers, and four of the five map
to code that genuinely implements them — unusual, and worth keeping. The
exception is Shivaswamy & Joachims, which is invoked in `priors.ts` for a claim
it does not make (see §2.4): the paper assumes history drawn from the reward
distribution and shows more of it is better, whereas the code needs a result
about _misspecified_ priors. Swap that one reference and the list is sound. The gap is that
nothing is cited for _inference_ — the estimation, stopping and multiplicity
questions — which is where all three high-severity findings live.

| Design decision                                  | Code                        | Grounding                                                                                                                                              |
| ------------------------------------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Thompson sampling, one posterior draw per serve  | `model.ts:chooseCell`       | Thompson (1933) Biometrika 25(3/4); Chapelle & Li (2011) NIPS 24, pp. 2249–2257; Agrawal & Goyal (2012 COLT, 2013 ICML)                                |
| Linear contextual bandit over hashed features    | `model.ts`, `context.ts`    | Li, Chu, Langford & Schapire (2010) WWW (LinUCB); Agrawal & Goyal (2013) ICML                                                                          |
| Joint multi-slot model with interaction features | `model.ts:cellFeatures`     | Hill, Nassif, Liu, Iyer & Vishwanathan (2017) KDD                                                                                                      |
| Feature hashing into fixed dimension             | `model.ts:dimForShape`      | Weinberger et al. (2009) ICML — **note: 2× ratio is below the guarantee regime**                                                                       |
| Warm-start priors (using history at all)         | `priors.ts`                 | Shivaswamy & Joachims (2012) AISTATS, pp. 1046–1054 — **assumes history is drawn from the same distribution as rewards**                               |
| Capping priors so data can override              | `priors.ts`                 | **Miscited.** Shivaswamy & Joachims proves more history is better; the cap is grounded in prior _misspecification_ — Loecher (2021) Front. AI 4:715690 |
| Beta-Bernoulli posterior, Monte Carlo P(best)    | `decide.ts:analyzeOutcomes` | Scott (2010) ASMBI; Scott (2015)                                                                                                                       |
| Expected-loss ("value remaining") stopping       | `decide.ts`                 | Scott (2010) — **but see Loecher (2021) on peeking**                                                                                                   |
| Wilson score interval                            | `stats-derive.ts:wilson95`  | Wilson (1927); Brown, Cai & DasGupta (2001) Statist. Sci.                                                                                              |
| Manual (not automatic) outlier exclusion         | `exclusions.ts`             | Kohavi, Tang & Xu (2020) _Trustworthy Online Controlled Experiments_                                                                                   |
| **Missing: adaptive-data estimation**            | finding 1                   | Nie et al. (2018) AISTATS; Shin et al. (2019) NeurIPS; Hadad et al. (2021) PNAS 118(15); Zhang et al. (2020) arXiv:2002.03217                          |
| **Missing: anytime-valid stopping**              | finding 2                   | Johari et al. (2017) KDD / (2022) Oper. Res. 70(3); Howard et al. (2021) Ann. Statist. 49(2); Loecher (2021) Front. AI 4:715690                        |
| **Missing: segment multiplicity**                | finding 3                   | Benjamini & Hochberg (1995); Deng et al. (2017) WSDM; Gelman et al. (2012)                                                                             |
| **Missing: SRM / traffic diagnostics**           | §4 note 4                   | Fabijan et al. (2019) KDD                                                                                                                              |

### The one framing issue worth raising

The README argues against the classic flow — "Decided once, on early openers,
one element at a time, one answer for everyone, and it ends" — and every part of
that critique is fair. But the implied trade is presented as free, and it isn't.
Adaptive allocation buys lower regret and pays in inferential precision: the
starved arm's estimate is biased (finding 1) and any repeatedly-evaluated
stopping rule loses its nominal guarantee (finding 2). This is the recognized
tension in the literature, not a defect unique to this implementation — Scott
(2015) and Kohavi et al. (2020) both discuss when a bandit is preferable to a
controlled experiment and when it is not. The honest version of the pitch is
that LiveVariant optimizes _earnings while learning_ rather than _measurement
precision_, and that for a campaign whose goal is conversions rather than a
publishable effect size, that is the right trade. Saying so would strengthen the
argument, not weaken it — and it sets accurate expectations for the number a
customer reads off the dashboard.

---

## Appendix A — Citation verification

Every reference in this document was checked against an authoritative metadata
source **after** the findings were written. This appendix records the outcome,
including the corrections it forced, so the grounding can be audited rather than
trusted.

**Method.** Crossref REST API (bibliographic + author query) for anything with a
DOI; the arXiv API for machine-learning proceedings papers Crossref does not
index; **dblp** for the two older proceedings papers neither indexes; and
full-text retrieval (PMLR, and the Hill et al. KDD paper) wherever a _claim_
rather than a citation needed checking. Raw responses in `crossref_raw.json` and
`dblp_raw.json`. **All 25 references are now confirmed to exist as cited.**

### Verified (authors, year, venue, volume/issue, DOI all confirmed)

| Reference                                              | Confirmed as                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------------ |
| Hadad, Hirshberg, Zhan, Wager & Athey 2021             | PNAS 118(15), doi:10.1073/pnas.2014602118                                |
| Johari, Koomen, Pekelis & Walsh 2017                   | KDD '17, doi:10.1145/3097983.3097992                                     |
| Johari, Koomen, Pekelis & Walsh 2022                   | Operations Research 70(3), doi:10.1287/opre.2021.2135                    |
| Loecher 2021                                           | Frontiers in Artificial Intelligence 4, doi:10.3389/frai.2021.715690     |
| Weinberger, Dasgupta, Langford, Smola & Attenberg 2009 | ICML '09, doi:10.1145/1553374.1553516                                    |
| Benjamini & Hochberg 1995                              | JRSS-B 57(1), doi:10.1111/j.2517-6161.1995.tb02031.x                     |
| Deng, Lu & Litz 2017                                   | WSDM '17, doi:10.1145/3018661.3018677                                    |
| Gelman, Hill & Yajima 2012                             | J. Res. Educational Effectiveness 5(2), doi:10.1080/19345747.2011.618213 |
| Fabijan, Gupchup, Gupta, Omhover & Qin 2019            | KDD '19, doi:10.1145/3292500.3330722                                     |
| Brown, Cai & DasGupta 2001                             | Statistical Science 16(2), doi:10.1214/ss/1009213286                     |
| Wilson 1927                                            | JASA 22(158), doi:10.1080/01621459.1927.10502953                         |
| Scott 2010                                             | Appl. Stoch. Models Bus. Ind. 26(6), doi:10.1002/asmb.874                |
| Scott 2015                                             | Appl. Stoch. Models Bus. Ind. 31(1), doi:10.1002/asmb.2104               |
| Li, Chu, Langford & Schapire 2010                      | WWW '10, doi:10.1145/1772690.1772758                                     |
| Hill, Nassif, Liu, Iyer & Vishwanathan 2017            | KDD '17, doi:10.1145/3097983.3098184                                     |
| Thompson 1933                                          | Biometrika 25(3/4), doi:10.2307/2332286                                  |
| Nie, Tian, Taylor & Zou 2018                           | AISTATS (21st), arXiv:1708.01977                                         |
| Shin, Ramdas & Rinaldo 2019                            | NeurIPS 32 (spotlight), arXiv:1905.11397                                 |
| Zhang, Janson & Murphy 2020                            | arXiv:2002.03217                                                         |
| Agrawal & Goyal 2013                                   | ICML, arXiv:1209.3352                                                    |
| Agrawal & Goyal 2012                                   | COLT, arXiv:1111.1797                                                    |
| Howard, Ramdas, McAuliffe & Sekhon 2021                | Annals of Statistics 49(2), doi:10.1214/20-aos1991                       |

### Corrections this check forced

1. **Hill et al.'s 21% figure had the wrong comparison base.** I wrote "21% lift
   over sequential per-element testing". The paper states a 21% conversion
   increase _compared to the median layout_, after one week of online
   optimization. Corrected in §2.2. The claim that per-slot testing cannot find
   interactions still stands — my own 3×3 simulation demonstrates it directly —
   but that number does not measure it.
2. **Howard et al.'s title was incomplete**: "Time-uniform, **nonparametric**,
   nonasymptotic confidence sequences". Corrected.
3. **Zhang et al.'s venue removed.** I asserted NeurIPS; arXiv confirms paper
   and authors, but I could not confirm that venue, so it is cited by arXiv id.
4. **Johari et al.'s "5–10×" inflation figure removed** — a specific multiplier
   I had not verified. The qualitative claim is retained; finding 2's own
   measurement demonstrates the effect independently.
5. **Shin et al. exists in two versions** — the NeurIPS 2019 paper cited here
   and a later journal version, _On the Bias, Risk, and Consistency of Sample
   Means in Multi-armed Bandits_ (SIAM J. Math. Data Sci. 3(4), 2021,
   doi:10.1137/20m1361249). Either supports finding 1.

### Previously unverified — now resolved via dblp

Both remaining references were confirmed against **dblp** (the authoritative
computer-science bibliography), which indexes the older ML proceedings that
Crossref and arXiv do not:

| Reference                  | Confirmed as                                                                                                            | Record                                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Chapelle & Li 2011         | _An Empirical Evaluation of Thompson Sampling_, NIPS 24, pp. 2249–2257 (Olivier Chapelle, Lihong Li)                    | `dblp.org/rec/conf/nips/ChapelleL11`       |
| Shivaswamy & Joachims 2012 | _Multi-armed Bandit Problems with History_, AISTATS 2012, pp. 1046–1054 (Pannagadatta K. Shivaswamy, Thorsten Joachims) | `dblp.org/rec/journals/jmlr/ShivaswamyJ12` |

Both exist exactly as the repo cites them. **No dagger remains on any reference
in this review.**

### One citation is apt, one is not

Because `priors.ts` rests a design decision on Shivaswamy & Joachims, I fetched
the full paper (PMLR v22) rather than stopping at bibliographic confirmation.
**The paper does not support the claim the code attributes to it** — see §2.4.
In the paper's own words:

- _"The results show that a logarithmic amount of historic data can reduce
  regret from logarithmic to constant."_
- _"as the number of historic observations for every arm tends to infintiy [sic],
  the regret achieved is zero"_
- _"The historic rewards for each arm are assumed to be drawn independently from
  the same distributions as the non-historic rewards."_

So its result is that **more** history is monotonically better, under an explicit
assumption that the history is drawn from the true reward distribution. It is not
a result about capping a possibly-wrong belief, and an LLM's guessed conversion
rate is exactly the case where its assumption fails. `priors.ts`'s cap remains
correct behaviour — §2.4's simulation shows even an adversarial prior at the cap
costs only ~28% delay — but the grounding should be prior misspecification
(Loecher 2021), not this paper.

This is the one case in either repo where a citation is used for something it
does not say. Worth fixing precisely _because_ the rest of the codebase's
citations are unusually well-matched to their code.

### What this appendix does not cover

Verification here establishes that each paper **exists as cited** and that its
bibliographic details are right. It does not re-derive each paper's results. The
mapping from a paper to a finding is my own reading; where a finding rests on
measurement, the measurement is in §3 and reproducible via `lv_port.py`
independent of whether the citation is apt.
