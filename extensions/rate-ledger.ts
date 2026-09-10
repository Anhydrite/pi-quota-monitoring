/**
 * Derives the billed per-token rates from the gateway's own invoices.
 *
 * The Command Code API reports, for every request, the amount it billed
 * (`inputInferenceCost`, `outputInferenceCost`) and the token counts (fresh
 * input, cache reads, output). It reports prices per *request*, never a rate
 * card — so the rates are recovered from the bills themselves.
 *
 * Two exact facts make this possible:
 *
 *  - output is billed at a single per-token rate, so
 *    `outputInferenceCost / outputTokens` IS the output rate for that request;
 *  - the gateway bills one input-side amount covering fresh tokens AND cache
 *    reads, so `inputInferenceCost = fresh * rFresh + cache * rCache`. Two
 *    unknown rates, but any two requests with different fresh/cache mixes give
 *    two independent equations — solved here by least squares.
 *
 * Requests are grouped by their observed output rate, which changes when the
 * gateway switches price window (peak/off-peak). No window calendar and no
 * price table is embedded: the grouping comes from the data, so a rate change
 * is detected as soon as it is billed.
 *
 * When the rates of a group are not solvable yet (a mix that has not varied),
 * callers must show nothing rather than a guess.
 */

export interface BilledRates {
  /** USD per million fresh input tokens. */
  fresh: number;
  /** USD per million cache-read tokens. */
  cache: number;
  /** USD per million output tokens. */
  output: number;
  /** How many requests back these rates. */
  samples: number;
}

interface Accumulator {
  // Least squares for `fresh * S11 + cache * S12 = B1` style normal equations.
  s11: number;
  s12: number;
  s22: number;
  b1: number;
  b2: number;
  outputCost: number;
  outputTokens: number;
  requests: number;
}

export interface UsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
}

/** Round a USD/M rate to a stable group key (rates are exact per window). */
function groupKey(outputRate: number): string {
  if (!Number.isFinite(outputRate) || outputRate <= 0) return "unknown";
  // 5 significant decimals is far finer than any real rate difference while
  // keeping float noise from splitting one window into many groups.
  return (Math.round(outputRate * 1e5) / 1e5).toFixed(5);
}

function rateOf(cost: number | undefined, tokens: number | undefined): number | null {
  const c = typeof cost === "number" && Number.isFinite(cost) ? cost : null;
  const t = typeof tokens === "number" && Number.isFinite(tokens) ? tokens : null;
  if (c === null || t === null || t <= 0 || c < 0) return null;
  return (c / t) * 1_000_000;
}

export class RateLedger {
  private groups = new Map<string, Accumulator>();
  /** Most recently observed group key, used to report the current window. */
  private lastKey: string | null = null;

  /**
   * Feed one billed request. `model` keeps different models in separate rate
   * groups (two models can share an output rate while charging different
   * input rates). Returns the group key it landed in, or null.
   */
  record(usage: UsageLike, model = "unknown"): string | null {
    const cost = usage?.cost;
    if (!cost) return null;
    // Tokens are carried in millions so the solved coefficients are already
    // USD per million (raw token units make the system ill-conditioned: cache
    // counts are ~1000x the fresh counts).
    const fresh = Number(usage.input ?? 0) / 1e6;
    const cache = (Number(usage.cacheRead ?? 0) + Number(usage.cacheWrite ?? 0)) / 1e6;
    const outputTokens = Number(usage.output ?? 0);
    // The whole input side is `cost.input + cost.cacheRead + cost.cacheWrite`:
    // that holds whether the reader kept the input amount whole (current) or
    // attributed it across fresh/cache (older records), so mixed history still
    // fits one consistent equation.
    const inputCost =
      Number(cost.input ?? 0) + Number(cost.cacheRead ?? 0) + Number(cost.cacheWrite ?? 0);
    const outputCost = Number(cost.output ?? 0);

    const outputRate = rateOf(outputCost, outputTokens);
    // Without an output rate the request cannot be attributed to a price
    // window; it carries no usable rate information.
    if (outputRate === null) return null;

    const key = `${model}|${groupKey(outputRate)}`;
    const acc = this.groups.get(key) ?? {
      s11: 0,
      s12: 0,
      s22: 0,
      b1: 0,
      b2: 0,
      outputCost: 0,
      outputTokens: 0,
      requests: 0,
    };
    acc.s11 += fresh * fresh;
    acc.s12 += fresh * cache;
    acc.s22 += cache * cache;
    acc.b1 += fresh * inputCost;
    acc.b2 += cache * inputCost;
    acc.outputCost += outputCost;
    acc.outputTokens += outputTokens;
    acc.requests += 1;
    this.groups.set(key, acc);
    this.lastKey = key;
    return key;
  }
  /**
   * Rates for the most recently recorded request, or null while they cannot be
   * established from the bills actually seen.
   */
  currentRates(): BilledRates | null {
    return this.lastKey ? this.ratesForKey(this.lastKey) : null;
  }

  ratesForKey(key: string): BilledRates | null {
    const acc = this.groups.get(key);
    if (!acc) return null;
    const output = rateOf(acc.outputCost, acc.outputTokens);
    if (output === null) return null;

    // Solve [s11 s12; s12 s22][fresh cache]^T = [b1 b2]^T.
    const det = acc.s11 * acc.s22 - acc.s12 * acc.s12;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-9) {
      // Every sample in this window had the same fresh/cache mix: the input
      // amount alone cannot separate the two rates.
      return null;
    }
    const fresh = (acc.b1 * acc.s22 - acc.b2 * acc.s12) / det;
    const cache = (acc.s11 * acc.b2 - acc.s12 * acc.b1) / det;
    if (!Number.isFinite(fresh) || !Number.isFinite(cache)) return null;
    // Negative rates are not a valid solution: the mix has not varied enough
    // for a reliable fit yet.
    if (fresh < 0 || cache < 0) return null;
    return { fresh, cache, output, samples: acc.requests };
  }

  /** Number of price windows seen so far (diagnostics/tests). */
  get windowCount(): number {
    return this.groups.size;
  }
}

/**
 * Plan multiplier: how many credits (USD of usage) one paid dollar buys.
 * Both operands come from the API (allowance) and the user (what they pay);
 * nothing is assumed. Returns null when either is unknown.
 */
export function planMultiplier(paidUsd: number | undefined, allowanceUsd: number | undefined): number | null {
  if (!paidUsd || paidUsd <= 0) return null;
  if (!allowanceUsd || allowanceUsd <= 0) return null;
  return allowanceUsd / paidUsd;
}
