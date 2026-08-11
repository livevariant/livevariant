"""Faithful Python port of LiveVariant's core numerics (packages/core/src).

Ported verbatim from the TypeScript so the audit measures THEIR arithmetic,
not a reimplementation of it: fnv1a32, dimForShape, cellFeatures,
newModel/observe/reward/chooseCell (Sherman-Morrison + Cholesky), the
mulberry32/Box-Muller/Marsaglia-Tsang samplers, analyzeOutcomes and wilson95.
"""
import numpy as np

MASK32 = 0xFFFFFFFF
MODEL_NOISE = 0.5
MIN_PULLS_TO_CALL = 100
MAX_CELLS = 512


def imul(a, b):
    """JS Math.imul: 32-bit signed multiply."""
    r = (a * b) & MASK32
    return r - 0x100000000 if r >= 0x80000000 else r


def fnv1a32(text):
    h = 0x811C9DC5
    for ch in text:
        h ^= ord(ch)
        h = imul(h, 0x01000193) & MASK32
    return h & MASK32


def hashed(dim, key):
    return 1 + (fnv1a32(key) % (dim - 1))


def variant_feature(dim, slot, variant):
    return hashed(dim, f"s{slot}={variant}")


def ctx_variant_feature(dim, ctx_feat, slot, variant):
    return hashed(dim, f"x{ctx_feat}|s{slot}={variant}")


def feature_indices(ctx, dim):
    """context.ts featureIndices: bias + one hashed slot per key=value."""
    idx = {0}
    for k, v in (ctx or {}).items():
        idx.add(1 + (fnv1a32(f"{k}={v}") % (dim - 1)))
    return sorted(idx)


def cell_count(slot_sizes):
    n = 1
    for s in slot_sizes:
        n *= s
    return n


def decode_cell(slot_sizes, cell):
    choice = [0] * len(slot_sizes)
    rest = cell
    for i in range(len(slot_sizes) - 1, -1, -1):
        choice[i] = rest % slot_sizes[i]
        rest //= slot_sizes[i]
    return choice


def encode_cell(slot_sizes, choice):
    cell = 0
    for i in range(len(slot_sizes)):
        cell = cell * slot_sizes[i] + choice[i]
    return cell


def cell_features(dim, slot_sizes, cell, ctx_feat_idx):
    """model.ts cellFeatures: bias, ctx, variant mains, slot x slot, ctx x variant."""
    choice = decode_cell(slot_sizes, cell)
    feats = {0}
    ctx = [f for f in ctx_feat_idx if isinstance(f, int) and 0 < f < dim]
    feats.update(ctx)
    for i in range(len(choice)):
        feats.add(variant_feature(dim, i, choice[i]))
        for j in range(i + 1, len(choice)):
            feats.add(hashed(dim, f"s{i}={choice[i]}|s{j}={choice[j]}"))
        for f in ctx:
            feats.add(ctx_variant_feature(dim, f, i, choice[i]))
    return sorted(feats)


def feature_names(slot_sizes, ctx_values):
    """Every distinct feature NAME a test of this shape can express.

    ctx_values: {dim_key: [values]}. Mirrors cellFeatures' name construction,
    which is what collides when two names hash to one index.
    """
    names = set()
    ctx_names = [f"{k}={v}" for k, vs in ctx_values.items() for v in vs]
    names.update(ctx_names)
    for cell in range(cell_count(slot_sizes)):
        choice = decode_cell(slot_sizes, cell)
        for i in range(len(choice)):
            names.add(f"s{i}={choice[i]}")
            for j in range(i + 1, len(choice)):
                names.add(f"s{i}={choice[i]}|s{j}={choice[j]}")
    return names, ctx_names


def dim_for_shape(slot_sizes, ctx_dim_count=0):
    mains = sum(slot_sizes)
    pairs = 0
    for i in range(len(slot_sizes)):
        for j in range(i + 1, len(slot_sizes)):
            pairs += slot_sizes[i] * slot_sizes[j]
    ctx = ctx_dim_count * (8 + mains)
    wanted = 2 * (1 + mains + pairs + ctx)
    dim = 16
    while dim < wanted and dim < 256:
        dim *= 2
    return dim


class Mulberry32:
    """rng.ts mulberry32, bit-exact."""

    def __init__(self, seed):
        self.a = seed & MASK32

    def __call__(self):
        self.a = (self.a + 0x6D2B79F5) & MASK32
        t = self.a
        t = imul(t ^ (t >> 15), t | 1) & MASK32
        t ^= (t + imul(t ^ (t >> 7), t | 61)) & MASK32
        t &= MASK32
        return ((t ^ (t >> 14)) & MASK32) / 4294967296


def sample_gaussian(rng):
    u = 0.0
    while u == 0.0:
        u = rng()
    return np.sqrt(-2 * np.log(u)) * np.cos(2 * np.pi * rng())


def sample_gamma(shape, rng):
    if shape < 1:
        return sample_gamma(shape + 1, rng) * (rng() or np.finfo(float).eps) ** (1 / shape)
    d = shape - 1 / 3
    c = 1 / np.sqrt(9 * d)
    while True:
        while True:
            x = sample_gaussian(rng)
            v = 1 + c * x
            if v > 0:
                break
        v = v * v * v
        u = rng()
        if u < 1 - 0.0331 * x**4:
            return d * v
        if u > 0 and np.log(u) < 0.5 * x * x + d * (1 - v + np.log(v)):
            return d * v


def sample_beta(alpha, beta, rng):
    a = sample_gamma(alpha, rng)
    b = sample_gamma(beta, rng)
    return a / (a + b)


class JointModel:
    """model.ts newModel/observe/reward/chooseCell."""

    def __init__(self, dim, priors=None):
        self.dim = dim
        self.a_inv = np.eye(dim)
        self.b = np.zeros(dim)
        for p in priors or []:
            if p["strength"] <= 0:
                continue
            if p.get("ctx_feat_idx"):
                feats = [ctx_variant_feature(dim, cf, p["slot"], p["variant"])
                         for cf in p["ctx_feat_idx"]]
            else:
                feats = [variant_feature(dim, p["slot"], p["variant"])]
            for f in feats:
                self.a_inv[f, f] = 1 / (1 / self.a_inv[f, f] + p["strength"])
                self.b[f] += p["strength"] * p["mean"]

    def observe(self, feat_idx):
        u = self.a_inv[:, feat_idx].sum(axis=1)
        denom = 1.0 + u[feat_idx].sum()
        self.a_inv -= np.outer(u, u) / denom
        self.a_inv = (self.a_inv + self.a_inv.T) / 2

    def reward(self, feat_idx):
        self.b[feat_idx] += 1

    def choose_cell(self, slot_sizes, ctx_feat_idx, rng, noise=MODEL_NOISE):
        theta_hat = self.a_inv @ self.b
        # Their cholesky() clamps tiny negatives, matching float drift handling.
        chol = cholesky_clamped(self.a_inv)
        z = np.array([sample_gaussian(rng) for _ in range(self.dim)])
        theta = theta_hat + noise * (chol @ z)
        best, best_score = 0, -np.inf
        for cell in range(cell_count(slot_sizes)):
            score = theta[cell_features(self.dim, slot_sizes, cell, ctx_feat_idx)].sum()
            if score > best_score:
                best_score, best = score, cell
        return best


def cholesky_clamped(m):
    dim = len(m)
    l = np.zeros((dim, dim))
    for i in range(dim):
        for j in range(i + 1):
            s = m[i][j] - l[i, :j] @ l[j, :j]
            if i == j:
                l[i, j] = np.sqrt(max(s, np.finfo(float).eps))
            else:
                l[i, j] = s / l[j, j]
    return l


def analyze_outcomes(arms, draws=20_000, seed=0x5EED, threshold=0.01, rng=None):
    """decide.ts analyzeOutcomes, including its exact posterior-mean rates."""
    rng = rng or Mulberry32(seed)
    n = len(arms)
    if n == 0:
        return dict(probabilities=[], leader=-1, expected_loss=0.0,
                    relative_loss=0.0, can_stop=False, rates=[])
    rates = [(1 + c) / (2 + max(p, c)) for p, c in arms]
    leader = int(np.argmax(rates))
    wins = np.zeros(n)
    loss_total = 0.0
    for _ in range(draws):
        s = [sample_beta(1 + c, 1 + max(0, p - c), rng) for p, c in arms]
        best = int(np.argmax(s))
        wins[best] += 1
        loss_total += max(0.0, s[best] - s[leader])
    expected_loss = loss_total / draws
    leader_rate = rates[leader]
    relative_loss = expected_loss / leader_rate if leader_rate > 0 else np.inf
    return dict(
        probabilities=(wins / draws).tolist(),
        leader=leader,
        expected_loss=expected_loss,
        relative_loss=relative_loss,
        can_stop=relative_loss <= threshold and any(p >= MIN_PULLS_TO_CALL for p, _ in arms),
        rates=rates,
    )


def wilson95(conversions, pulls):
    """stats-derive.ts wilson95."""
    if pulls == 0:
        return (0.0, 1.0)
    z = 1.96
    p = conversions / pulls
    denom = 1 + z**2 / pulls
    center = (p + z**2 / (2 * pulls)) / denom
    spread = (z * np.sqrt((p * (1 - p) + z**2 / (4 * pulls)) / pulls)) / denom
    return (max(0.0, center - spread), min(1.0, center + spread))


def marginal_outcomes(cells, slot_sizes, slot):
    """decide.ts marginalOutcomes."""
    out = [[0, 0] for _ in range(slot_sizes[slot])]
    stride = 1
    for i in range(slot + 1, len(slot_sizes)):
        stride *= slot_sizes[i]
    for cell in range(len(cells)):
        v = (cell // stride) % slot_sizes[slot]
        out[v][0] += cells[cell][0]
        out[v][1] += cells[cell][1]
    return out
