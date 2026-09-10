/**
 * The extension never fabricates a price or a plan cost.
 *
 * The readout shows rates recovered from the gateway's own invoices (see
 * rate-ledger.test.ts) and, only when the user has declared what they pay, the
 * same rates after the plan multiplier. This file guards the configuration
 * contract and the "no static price knowledge" rule.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const agentDir = await mkdtemp(join(tmpdir(), "pi-quota-cost-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const { DEFAULT_CONFIG, loadConfig, saveConfig } = await import("../extensions/request-cost.ts");

const SETTINGS_PATH = join(agentDir, "settings.json");

async function writeSettings(value: unknown): Promise<void> {
  await writeFile(SETTINGS_PATH, JSON.stringify(value), "utf-8");
}

describe("configuration", () => {
  it("defaults to disabled with no declared plan price", async () => {
    await writeSettings({});
    const config = await loadConfig();
    assert.equal(config.enabled, DEFAULT_CONFIG.enabled);
    assert.equal(config.planMonthlyUsd, undefined);
  });

  it("keeps only what it can honour", async () => {
    await writeSettings({ quotaCost: { enabled: true, unknownField: "x" } });
    const config = await loadConfig();
    assert.deepEqual(Object.keys(config).sort(), ["enabled"]);
  });

  it("reads a declared plan price", async () => {
    await writeSettings({ quotaCost: { enabled: true, planMonthlyUsd: 10 } });
    const config = await loadConfig();
    assert.equal(config.planMonthlyUsd, 10);
  });

  it("rejects a nonsensical plan price instead of guessing", async () => {
    for (const bad of [0, -5, "10", null]) {
      await writeSettings({ quotaCost: { enabled: true, planMonthlyUsd: bad } });
      const config = await loadConfig();
      assert.equal(config.planMonthlyUsd, undefined, `plan price ${JSON.stringify(bad)}`);
    }
  });

  it("persists the enable flag and the plan price together", async () => {
    await writeSettings({ quotaCost: { enabled: false } });
    await saveConfig({ enabled: true });
    await saveConfig({ planMonthlyUsd: 10 });
    const stored = JSON.parse(await readFile(SETTINGS_PATH, "utf-8"));
    assert.deepEqual(stored.quotaCost, { enabled: true, planMonthlyUsd: 10 });
  });
});

describe("no fabricated pricing in the source", () => {
  it("carries no rate card and no assumed plan amount", async () => {
    const source = await readFile(new URL("../extensions/request-cost.ts", import.meta.url), "utf-8");
    for (const banned of [
      "MODEL_COSTS",
      "PLAN_USD",
      "PLANS",
      "detectPlan",
      "creditMultiplier",
      "fmtBreakdown",
    ]) {
      assert.ok(!source.includes(banned), `${banned} must not reappear`);
    }
  });

  it("hard-codes no per-model rate anywhere in the extension", async () => {
    for (const file of ["request-cost.ts", "request-cost-index.ts", "rate-ledger.ts"]) {
      const source = await readFile(new URL(`../extensions/${file}`, import.meta.url), "utf-8");
      // A literal rate would look like `0.3`/`0.66`/`1.2` attached to a per-M
      // unit or a model id; the extension must learn rates from invoices only.
      assert.ok(!/perM\s*[:=]\s*\d/.test(source), `${file}: literal per-M rate`);
      assert.ok(
        !/deepseek|claude|gpt-|qwen|kimi/i.test(source),
        `${file}: model ids must not appear (rates are per-model data, not source)`,
      );
    }
  });
});
