/**
 * Billed rates are recovered from the gateway's own invoices.
 *
 * The API publishes no rate card: it reports, per request, what it billed on the
 * input side and the output side, plus token counts. Two exact facts make the
 * rates recoverable:
 *
 *  - output is billed at one per-token rate, so `outputCost / outputTokens` IS
 *    the output rate;
 *  - `inputCost = fresh * rFresh + cache * rCache`, so requests with different
 *    fresh/cache mixes solve the two input rates.
 *
 * These tests pin that contract, including the important negative cases: an
 * unsolvable mix must yield nothing rather than a guess.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { planMultiplier, RateLedger, type UsageLike } from "../extensions/rate-ledger.ts";
import {
  buildRateSegment,
  composeStatusLine,
  fmtPerM,
  rateSegmentCandidates,
} from "../extensions/request-cost.ts";

/** Billed request builder: amounts derived from explicit rates (test oracle). */
function billed(
  fresh: number,
  cache: number,
  output: number,
  rates: { fresh: number; cache: number; output: number },
): UsageLike {
  return {
    input: fresh,
    output,
    cacheRead: cache,
    cacheWrite: 0,
    totalTokens: fresh + cache + output,
    cost: {
      input: (fresh / 1e6) * rates.fresh + (cache / 1e6) * rates.cache,
      output: (output / 1e6) * rates.output,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

/** A real peak-window sequence captured from the live gateway. */
const PEAK = { fresh: 0.3, cache: 0.006, output: 1.2 };
/** The same model off-peak (recovered from the user's own history). */
const OFF_PEAK = { fresh: 0.22, cache: 0.007, output: 0.66 };

const REAL_PEAK_SAMPLES: Array<[number, number, number]> = [
  [508, 261632, 652],
  [1745, 260224, 1725],
  [168, 263552, 92],
  [428, 263808, 236],
  [235, 264320, 80],
  [332, 264576, 327],
  [457, 265216, 1527],
  [588, 267136, 2360],
  [242, 270080, 1670],
  [6267, 261888, 2566],
];

describe("billed rates — recovery from invoices", () => {
  it("needs at least two requests before any rate can be shown", () => {
    const ledger = new RateLedger();
    // The output rate is knowable from one request, but the input side needs two
    // independent equations. Until then the readout shows nothing at all rather
    // than a half-answer.
    ledger.record(billed(1000, 5000, 400, PEAK), "m");
    assert.equal(ledger.currentRates(), null);
  });

  it("recovers all three rates from a few real peak samples", () => {
    const ledger = new RateLedger();
    for (const [f, c, o] of REAL_PEAK_SAMPLES) ledger.record(billed(f, c, o, PEAK), "m");
    const rates = ledger.currentRates();
    assert.ok(rates, "varied mixes must be solvable");
    assert.ok(Math.abs(rates.fresh - PEAK.fresh) < 1e-6, `fresh ${rates.fresh}`);
    assert.ok(Math.abs(rates.cache - PEAK.cache) < 1e-6, `cache ${rates.cache}`);
    assert.ok(Math.abs(rates.output - PEAK.output) < 1e-9, `output ${rates.output}`);
  });

  it("shows nothing while the fresh/cache mix has not varied", () => {
    const ledger = new RateLedger();
    // Same split twice: two equations, but only one independent one.
    ledger.record(billed(200, 200_000, 300, PEAK), "m");
    ledger.record(billed(200, 200_000, 300, PEAK), "m");
    assert.equal(
      ledger.currentRates(),
      null,
      "an unsolvable mix must not produce invented input rates",
    );
  });

  it("shows nothing for a request the gateway did not price", () => {
    const ledger = new RateLedger();
    const key = ledger.record({ input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }, "m");
    assert.equal(key, null);
    assert.equal(ledger.currentRates(), null);
  });

  it("separates price windows without any window calendar", () => {
    const ledger = new RateLedger();
    for (const [f, c, o] of REAL_PEAK_SAMPLES) ledger.record(billed(f, c, o, OFF_PEAK), "m");
    const before = ledger.currentRates();
    assert.ok(before);
    assert.ok(Math.abs(before.output - OFF_PEAK.output) < 1e-9);

    // The gateway switches to a different price: the group changes on its own.
    for (const [f, c, o] of REAL_PEAK_SAMPLES) ledger.record(billed(f, c, o, PEAK), "m");
    const after = ledger.currentRates();
    assert.ok(after);
    assert.ok(Math.abs(after.output - PEAK.output) < 1e-9, "new window detected from the bill");
    assert.ok(Math.abs(after.fresh - PEAK.fresh) < 1e-6);
    assert.equal(ledger.windowCount, 2, "one group per billed price, no calendar needed");
  });

  it("keeps different models apart", () => {
    const ledger = new RateLedger();
    for (const [f, c, o] of REAL_PEAK_SAMPLES) ledger.record(billed(f, c, o, PEAK), "model-a");
    for (const [f, c, o] of REAL_PEAK_SAMPLES) ledger.record(billed(f, c, o, OFF_PEAK), "model-b");
    const current = ledger.currentRates();
    assert.ok(current);
    assert.ok(Math.abs(current.output - OFF_PEAK.output) < 1e-9, "last model wins, not a blend");
    assert.equal(ledger.windowCount, 2);
  });

  it("reads an older attributed record the same way as a whole-input record", () => {
    // Old readers split the input amount across fresh and cache; current ones
    // keep it whole. Both must feed the same equation, so mixed history from a
    // single session still fits.
    const toAttributed = (u: UsageLike): UsageLike => {
      const fresh = u.input ?? 0;
      const cache = u.cacheRead ?? 0;
      return {
        ...u,
        cost: {
          input: (fresh / 1e6) * PEAK.fresh,
          cacheRead: (cache / 1e6) * PEAK.cache,
          output: (u.cost?.output ?? 0),
          cacheWrite: 0,
          total: 0,
        },
      };
    };
    const wholeLedger = new RateLedger();
    const mixedLedger = new RateLedger();
    REAL_PEAK_SAMPLES.forEach(([f, c, o], index) => {
      const whole = billed(f, c, o, PEAK);
      wholeLedger.record(whole, "m");
      // Alternate conventions inside one session, as a version change would.
      mixedLedger.record(index % 2 === 0 ? whole : toAttributed(whole), "m");
    });
    const a = wholeLedger.currentRates();
    const b = mixedLedger.currentRates();
    assert.ok(a && b, "both ledgers must be solvable");
    assert.ok(Math.abs(a.fresh - b.fresh) < 1e-9, "mixed conventions must not shift the fit");
    assert.ok(Math.abs(a.cache - b.cache) < 1e-9);
    assert.ok(Math.abs(a.output - b.output) < 1e-9);
  });
});

describe("plan cost — billed credits to money spent", () => {
  it("derives the multiplier from the API allowance and the declared price", () => {
    // The user pays 10 USD; the API reports a 69.98 USD allowance for the period.
    const multiplier = planMultiplier(10, 69.98);
    assert.ok(multiplier !== null);
    assert.ok(Math.abs(multiplier - 6.998) < 1e-9);
  });

  it("has no multiplier without a declared price", () => {
    assert.equal(planMultiplier(undefined, 69.98), null);
    assert.equal(planMultiplier(0, 69.98), null);
  });

  it("has no multiplier without an API allowance", () => {
    assert.equal(planMultiplier(10, undefined), null);
    assert.equal(planMultiplier(10, 0), null);
  });
});

describe("readout — billed rates and money spent", () => {
  it("shows the billed rates alone when the plan price is unknown", () => {
    const segment = buildRateSegment({ fresh: 0.3, cache: 0.006, output: 1.2 }, null);
    assert.equal(segment, "req ↑$0.300/M ↓$1.20/M R$0.006/M");
  });

  it("adds the real cost per rate once the multiplier is known", () => {
    const segment = buildRateSegment({ fresh: 0.3, cache: 0.006, output: 1.2 }, 6.998);
    assert.ok(segment);
    assert.equal(
      segment,
      "req ↑$0.300/M ↓$1.20/M R$0.006/M · réel ↑$0.043/M ↓$0.171/M R$0.0009/M",
    );
  });

  it("leaves the cache rate out when none was billed", () => {
    const segment = buildRateSegment({ fresh: 0.3, cache: 0, output: 1.2 }, null);
    assert.equal(segment, "req ↑$0.300/M ↓$1.20/M");
  });

  it("shows nothing when no rate is known", () => {
    assert.equal(buildRateSegment(null, 6.998), null);
    assert.equal(buildRateSegment({ fresh: 0, cache: 0, output: 0 }, 6.998), null);
  });

  it("formats per-million rates without fake precision", () => {
    assert.equal(fmtPerM(1.2), "$1.20");
    assert.equal(fmtPerM(0.3), "$0.300");
    assert.equal(fmtPerM(0.006), "$0.006", "sub-cent rates keep their digits, not padding");
    assert.equal(fmtPerM(0.0009), "$0.0009");
  });
});

describe("readout — billed rates and money spent", () => {
  it("shows the billed rates alone when the plan price is unknown", () => {
    const segment = buildRateSegment({ fresh: 0.3, cache: 0.006, output: 1.2 }, null);
    assert.equal(segment, "req ↑$0.300/M ↓$1.20/M R$0.006/M");
  });

  it("adds the real cost per rate once the multiplier is known", () => {
    const segment = buildRateSegment({ fresh: 0.3, cache: 0.006, output: 1.2 }, 6.998);
    assert.equal(
      segment,
      "req ↑$0.300/M ↓$1.20/M R$0.006/M · réel ↑$0.043/M ↓$0.171/M R$0.0009/M",
    );
  });

  it("leaves the cache rate out when none was billed", () => {
    assert.equal(
      buildRateSegment({ fresh: 0.3, cache: 0, output: 1.2 }, null),
      "req ↑$0.300/M ↓$1.20/M",
    );
  });

  it("shows nothing when no rate is known", () => {
    assert.equal(buildRateSegment(null, 6.998), null);
    assert.equal(buildRateSegment({ fresh: 0, cache: 0, output: 0 }, 6.998), null);
  });

  it("formats per-million rates without fake precision", () => {
    assert.equal(fmtPerM(1.2), "$1.20");
    assert.equal(fmtPerM(0.3), "$0.300");
    assert.equal(fmtPerM(0.006), "$0.006", "sub-cent rates keep their digits, not padding");
    assert.equal(fmtPerM(0.0009), "$0.0009");
  });
});

describe("readout — degradation on a narrow terminal", () => {
  const rates = { fresh: 0.3, cache: 0.006, output: 1.2 };
  const visible = (s: string) => s.length;
  const statuses = ["CC 5h: 15%", "mois: 3%"]; // 19 columns

  it("orders its forms from richest to most compact", () => {
    const candidates = rateSegmentCandidates(rates, 6.998);
    assert.deepEqual(candidates, [
      "req ↑$0.300/M ↓$1.20/M R$0.006/M · réel ↑$0.043/M ↓$0.171/M R$0.0009/M",
      "req ↑$0.300/M ↓$1.20/M R$0.006/M",
      "↑$0.300/M ↓$1.20/M R$0.006/M",
      "↓$1.20/M R$0.006/M",
      "↓$1.20/M",
    ]);
  });

  /** Whatever the width, report where (and which) fact was shown. */
  function shown(width: number): { text: string; onOwnLine: boolean } | null {
    const composed = composeStatusLine(statuses, rateSegmentCandidates(rates, 6.998), width, visible);
    if (composed.ownCostLine) return { text: composed.ownCostLine, onOwnLine: true };
    const line = composed.statusLine ?? "";
    const match = rateSegmentCandidates(rates, 6.998).find((c) => line.endsWith(c));
    return match ? { text: match, onOwnLine: false } : null;
  }

  it("always shows a real candidate, at every width", () => {
    for (const width of [10, 20, 30, 45, 60, 80, 120, 160]) {
      const result = shown(width);
      assert.ok(result, `a fact must survive width ${width}`);
      assert.ok(
        rateSegmentCandidates(rates, 6.998).includes(result.text),
        `width ${width}: shown text must be one of the real candidates`,
      );
    }
  });

  it("keeps the richest form that fits, preferring a dedicated line over a poorer one", () => {
    assert.deepEqual(shown(160), {
      text: "req ↑$0.300/M ↓$1.20/M R$0.006/M · réel ↑$0.043/M ↓$0.171/M R$0.0009/M",
      onOwnLine: false,
    });
    // 19 + 2 + 70 = 91 > 80, but 70 fits alone: the real-cost part is kept, on
    // a dedicated line, instead of being dropped for a poorer form.
    assert.deepEqual(shown(80), {
      text: "req ↑$0.300/M ↓$1.20/M R$0.006/M · réel ↑$0.043/M ↓$0.171/M R$0.0009/M",
      onOwnLine: true,
    });
    assert.deepEqual(shown(60), {
      text: "req ↑$0.300/M ↓$1.20/M R$0.006/M",
      onOwnLine: false,
    });
    assert.deepEqual(shown(45), {
      text: "req ↑$0.300/M ↓$1.20/M R$0.006/M",
      onOwnLine: true,
    });
    assert.deepEqual(shown(30), {
      text: "↑$0.300/M ↓$1.20/M R$0.006/M",
      onOwnLine: true,
    });
    assert.deepEqual(shown(20), {
      text: "↓$1.20/M R$0.006/M",
      onOwnLine: true,
    });
    assert.deepEqual(shown(10), { text: "↓$1.20/M", onOwnLine: true });
  });

  it("shows nothing at all when no rate is known", () => {
    const composed = composeStatusLine(statuses, rateSegmentCandidates(null, 6.998), 200, visible);
    assert.equal(composed.ownCostLine, null);
    assert.equal(composed.statusLine, statuses.join(" "), "quotas are untouched");
  });
});
