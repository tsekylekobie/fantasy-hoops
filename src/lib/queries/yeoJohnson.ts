// Yeo–Johnson power transform, as scikit-learn's PowerTransformer(method="yeo-johnson", standardize=True) does it:
// lambda by maximum likelihood over a sample, then the transformed values z-scored over that sample (population sd).
// Pure, tested (yeoJohnson.test.ts). Used by DURANT (value.ts).

/** ψ(x, λ). Defined for every real x, so zeros and negative shooting impact are fine. */
export function yeoJohnson(x: number, lambda: number): number {
  if (x >= 0) return Math.abs(lambda) < 1e-12 ? Math.log1p(x) : (Math.pow(x + 1, lambda) - 1) / lambda;
  return Math.abs(lambda - 2) < 1e-12 ? -Math.log1p(-x) : -(Math.pow(1 - x, 2 - lambda) - 1) / (2 - lambda);
}

function meanVar(xs: number[]): { mean: number; variance: number } {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return { mean, variance: xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length };
}

/** Profile log-likelihood of λ (Yeo & Johnson 2000), up to a constant. */
function logLikelihood(xs: number[], lambda: number): number {
  const { variance } = meanVar(xs.map((x) => yeoJohnson(x, lambda)));
  if (!(variance > 0) || !Number.isFinite(variance)) return -Infinity;
  const jacobian = xs.reduce((a, x) => a + Math.sign(x) * Math.log1p(Math.abs(x)), 0);
  return (-xs.length / 2) * Math.log(variance) + (lambda - 1) * jacobian;
}

/** λ is searched in [-LAMBDA_BOUND, LAMBDA_BOUND]: a grid for the best bracket, then golden-section search. */
export const LAMBDA_BOUND = 5;

/** The maximum-likelihood λ for `xs`; 1 (no transform) when the sample has no spread. */
export function fitLambda(xs: number[]): number {
  if (xs.length < 2 || xs.every((x) => x === xs[0])) return 1;
  const step = 0.25;
  let best = 1;
  let bestLl = logLikelihood(xs, 1);
  for (let l = -LAMBDA_BOUND; l <= LAMBDA_BOUND + 1e-9; l += step) {
    const ll = logLikelihood(xs, l);
    if (ll > bestLl) [best, bestLl] = [l, ll];
  }
  let lo = Math.max(-LAMBDA_BOUND, best - step);
  let hi = Math.min(LAMBDA_BOUND, best + step);
  const g = (Math.sqrt(5) - 1) / 2;
  let a = hi - g * (hi - lo);
  let b = lo + g * (hi - lo);
  let fa = logLikelihood(xs, a);
  let fb = logLikelihood(xs, b);
  for (let i = 0; i < 60 && hi - lo > 1e-7; i++) {
    if (fa > fb) {
      [hi, b, fb] = [b, a, fa];
      a = hi - g * (hi - lo);
      fa = logLikelihood(xs, a);
    } else {
      [lo, a, fa] = [a, b, fb];
      b = lo + g * (hi - lo);
      fb = logLikelihood(xs, b);
    }
  }
  const mid = (lo + hi) / 2;
  return logLikelihood(xs, mid) >= bestLl ? mid : best;
}

/**
 * Fits λ over `sample`, then returns a scorer: ψ(x, λ) standardized by the sample's transformed mean and
 * (population) sd. A sample with no spread scores everyone 0.
 */
export function fitPowerScaler(sample: number[]): ((x: number) => number) & { lambda: number } {
  if (sample.length === 0) return Object.assign(() => 0, { lambda: 1 });
  const lambda = fitLambda(sample);
  const { mean, variance } = meanVar(sample.map((x) => yeoJohnson(x, lambda)));
  const sd = Math.sqrt(variance);
  const score = (x: number) => (sd > 0 && Number.isFinite(sd) ? (yeoJohnson(x, lambda) - mean) / sd : 0);
  return Object.assign(score, { lambda });
}
