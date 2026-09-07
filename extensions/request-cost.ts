/**
 * request-cost — optional per-request cost readout for pi-quota-monitoring.
 *
 * When enabled (via the /quota-cost menu or settings), this module shows the
 * real per-request cost (last request + session average, broken down into
 * input / output / cache reads) on the same footer line as the quota
 * percentages, right-aligned, and hidden when the terminal is too narrow.
 *
 * Cost source: the `usage.cost` fields now carry the REAL billed cost from the
 * Command Code gateway (see the pi-commandcode-provider fork:
 * feat/real-api-cost), so no local catalog estimation or peak-hour guessing is
 * needed. Only models from quota-aware providers (commandcode, opencode-go)
 * are counted.
 *
 * Settings are persisted in ~/.pi/agent/settings.json under the "quotaCost"
 * key (mirroring the tokenSpeed pattern from pi-token-speed).
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SETTINGS_KEY = "quotaCost";
const SETTINGS_PATH = join(getAgentDir(), "settings.json");

export interface QuotaCostConfig {
  enabled: boolean;
}

export const DEFAULT_CONFIG: QuotaCostConfig = { enabled: false };

/** Accumulator for a single assistant request (or session totals). */
export interface CostTotals {
  requests: number;
  /** Costs in USD. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  /** Token counts. */
  tokInput: number;
  tokOutput: number;
  tokCacheRead: number;
  tokCacheWrite: number;
}

export function emptyTotals(): CostTotals {
  return {
    requests: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    tokInput: 0,
    tokOutput: 0,
    tokCacheRead: 0,
    tokCacheWrite: 0,
  };
}

// ---------------------------------------------------------------------------
// Settings persistence (S1.1)
// ---------------------------------------------------------------------------

async function readSettingsFile(): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(SETTINGS_PATH, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function writeSettingsFile(data: Record<string, unknown>): Promise<void> {
  await writeFile(SETTINGS_PATH, JSON.stringify(data, null, 2), "utf-8");
}

export async function loadConfig(): Promise<QuotaCostConfig> {
  const settings = await readSettingsFile();
  const raw = settings[SETTINGS_KEY];
  if (raw && typeof raw === "object" && typeof (raw as { enabled?: unknown }).enabled === "boolean") {
    return { enabled: (raw as { enabled: boolean }).enabled };
  }
  return { ...DEFAULT_CONFIG };
}

export async function saveConfig(partial: Partial<QuotaCostConfig>): Promise<QuotaCostConfig> {
  const settings = await readSettingsFile();
  const current = (settings[SETTINGS_KEY] as Partial<QuotaCostConfig>) || {};
  const next = { ...current, ...partial };
  settings[SETTINGS_KEY] = next;
  await writeSettingsFile(settings);
  return next as QuotaCostConfig;
}

// ---------------------------------------------------------------------------
// Per-request cost collection (S1.2)
// ---------------------------------------------------------------------------

export interface CostState {
  /** Last assistant request that carried usage (null until first request). */
  last: CostTotals | null;
  /** Session totals across all counted requests. */
  session: CostTotals;
}

export function createCostState(): CostState {
  return { last: null, session: emptyTotals() };
}

/**
 * Add one assistant request's usage to the state. Returns true when the usage
 * was counted (carried a cost), false when it was skipped (no usage / not a
 * supported provider).
 */
export function ingestUsage(state: CostState, provider: string | undefined, usage: unknown): boolean {
  if (!usage || typeof usage !== "object") return false;
  const u = usage as Record<string, unknown>;
  const cost = u.cost as Record<string, number> | undefined;
  if (!cost) return false;
  const prov = (provider ?? "").toLowerCase();
  if (prov !== "commandcode" && prov !== "opencode-go" && prov !== "opencode") return false;

  const totals: CostTotals = {
    requests: 1,
    input: num(cost.input),
    output: num(cost.output),
    cacheRead: num(cost.cacheRead),
    cacheWrite: num(cost.cacheWrite),
    total: num(cost.total),
    tokInput: num(u.input),
    tokOutput: num(u.output),
    tokCacheRead: num(u.cacheRead),
    tokCacheWrite: num(u.cacheWrite),
  };

  state.last = totals;
  state.session.requests += 1;
  for (const k of [
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "total",
    "tokInput",
    "tokOutput",
    "tokCacheRead",
    "tokCacheWrite",
  ] as const) {
    state.session[k] += totals[k];
  }
  return true;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// ---------------------------------------------------------------------------
// Display computation (S1.3)
// ---------------------------------------------------------------------------

/** Compact USD formatter tuned for per-request costs. */

/** Compact USD formatter tuned for per-request costs. */
export function fmtUsd(v: number): string {
  if (v >= 1) return `$${v.toFixed(2)}`;
  if (v >= 0.01) return `$${v.toFixed(3)}`;
  if (v >= 0.0001) return `$${v.toFixed(5)}`;
  return `$${v.toFixed(6)}`;
}


/** USD-per-million-tokens formatter. */
export function fmtPerM(v: number): string {
  if (v >= 100) return `$${v.toFixed(0)}`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  if (v >= 0.01) return `$${v.toFixed(3)}`;
  if (v >= 0.001) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(4)}`;
}

/**
 * Cost per million tokens for each component, e.g. `↑$0.22/M ↓$0.66/M R$0.007/M`.
 * Pass cost (USD) and token count per component; components with no tokens are skipped.
 */
export function fmtBreakdown(t: {
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  tokInput: number;
  tokOutput: number;
  tokCacheRead: number;
  tokCacheWrite: number;
}): string {
  const parts: string[] = [];
  const push = (symbol: string, cost: number, tokens: number) => {
    if (cost <= 0 || tokens <= 0) return;
    parts.push(`${symbol}${fmtPerM((cost / tokens) * 1_000_000)}/M`);
  };
  push("↑", t.inputCost, t.tokInput);
  push("↓", t.outputCost, t.tokOutput);
  push("R", t.cacheReadCost, t.tokCacheRead);
  push("W", t.cacheWriteCost, t.tokCacheWrite);
  return parts.join(" ");
}


/**
 * Build the right-aligned cost segment shown next to the quota readout.
 * Returns null when there is no data to show yet.
 *
 * Compact form: `req ↑$0.00003 ↓$0.00025 R$0.00220 · moy $0.00259 · $0.00776 · 0.08% de 10$`
 */

export function buildCostSegment(
  state: CostState,
  opts: { planUsd?: number; envPct?: number | null },
): string | null {
  if (!state.last && state.session.requests === 0) return null;

  const parts: string[] = [];
  if (state.last && state.last.total > 0) {
    const b = fmtBreakdown({
      inputCost: state.last.input,
      outputCost: state.last.output,
      cacheReadCost: state.last.cacheRead,
      cacheWriteCost: state.last.cacheWrite,
      tokInput: state.last.tokInput,
      tokOutput: state.last.tokOutput,
      tokCacheRead: state.last.tokCacheRead,
      tokCacheWrite: state.last.tokCacheWrite,
    });
    if (b) parts.push(`req ${b}`);
    else parts.push(`req ${fmtUsd(state.last.total)}`);
  }
  const avg = state.session.requests > 0 ? state.session.total / state.session.requests : 0;
  if (state.session.requests > 1 && avg > 0) {
    parts.push(`moy ${fmtUsd(avg)}`);
  }
  if (state.session.total > 0 && opts.planUsd && opts.planUsd > 0) {
    // Dollars spent out of the paid plan (no percentage).
    parts.push(`${fmtUsd(state.session.total)}/${opts.planUsd}$`);
  }
  if (parts.length === 0) return null;
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Default-footer replication (S2.1)
// ---------------------------------------------------------------------------
// Replicates the two default footer lines (pwd + stats/model) so that enabling
// the custom footer loses nothing. The third line (extension statuses) is
// recomposed by the caller with the cost segment right-aligned.

export interface FooterRenderInput {
  cwd: string;
  branch: string | null;
  sessionName: string | null;
  usageInput: number;
  usageOutput: number;
  usageCacheRead: number;
  usageCacheWrite: number;
  usageCost: number;
  latestCacheHitRate: number | null;
  contextPercent: number | null;
  contextWindow: number;
  modelId: string;
  modelProvider: string | null;
  modelReasoning: boolean;
  thinkingLevel: string | null;
  providerCount: number;
  autoCompactEnabled: boolean;
  experimental: boolean;
}

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

export function formatCwd(cwd: string, home: string | undefined): string {
  if (!home) return cwd;
  const resolved = resolvePath(cwd);
  const resolvedHome = resolvePath(home);
  if (resolved === resolvedHome) return "~";
  if (resolved.startsWith(resolvedHome + "/")) return `~${resolved.slice(resolvedHome.length)}`;
  return cwd;
}

function resolvePath(p: string): string {
  // Minimal POSIX normalization (no fs dependency in pure helpers).
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return (p.startsWith("/") ? "/" : "") + parts.join("/");
}

/** Build the pwd line (dim) — caller wraps with theme. */
export function buildPwdLine(input: FooterRenderInput): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  let pwd = formatCwd(input.cwd, home);
  if (input.branch) pwd = `${pwd} (${input.branch})`;
  if (input.sessionName) pwd = `${pwd} • ${input.sessionName}`;
  return pwd;
}

/** Build the stats + model line (plain, no ANSI — caller styles parts). */
export function buildStatsLine(input: FooterRenderInput): {
  statsLeft: string;
  rightSide: string;
} {
  const parts: string[] = [];
  if (input.usageInput) parts.push(`↑${formatTokens(input.usageInput)}`);
  if (input.usageOutput) parts.push(`↓${formatTokens(input.usageOutput)}`);
  if (input.usageCacheRead) parts.push(`R${formatTokens(input.usageCacheRead)}`);
  if (input.usageCacheWrite) parts.push(`W${formatTokens(input.usageCacheWrite)}`);
  if (
    (input.usageCacheRead > 0 || input.usageCacheWrite > 0) &&
    input.latestCacheHitRate !== null
  ) {
    parts.push(`CH${input.latestCacheHitRate.toFixed(1)}%`);
  }
  if (input.usageCost) {
    parts.push(`$${input.usageCost.toFixed(3)}`);
  }
  const autoIndicator = input.autoCompactEnabled ? " (auto)" : "";
  const ctxDisplay =
    input.contextPercent === null
      ? `?/${formatTokens(input.contextWindow)}${autoIndicator}`
      : `${input.contextPercent.toFixed(1)}%/${formatTokens(input.contextWindow)}${autoIndicator}`;
  parts.push(ctxDisplay);
  if (input.experimental) parts.push("xp");

  let rightSide = input.modelId;
  if (input.modelReasoning) {
    const level = input.thinkingLevel || "off";
    rightSide =
      level === "off" ? `${input.modelId} • thinking off` : `${input.modelId} • ${level}`;
  }
  if (input.providerCount > 1 && input.modelProvider) {
    rightSide = `(${input.modelProvider}) ${rightSide}`;
  }
  return { statsLeft: parts.join(" "), rightSide };
}

/** Compute the footer alignment exactly like pi's default footer. */
export function alignStatsLine(
  statsLeft: string,
  rightSide: string,
  width: number,
  truncate: (s: string, w: number) => string,
  visible: (s: string) => number,
): { line: string; rightVisible: boolean } {
  const minPadding = 2;
  let left = statsLeft;
  let leftWidth = visible(left);
  if (leftWidth > width) {
    left = truncate(left, width);
    leftWidth = visible(left);
  }
  // Try full provider prefix first, drop it if too wide (mirrors pi).
  let right = rightSide;
  let rightWidth = visible(right);
  const total = leftWidth + minPadding + rightWidth;
  if (total <= width) {
    const pad = " ".repeat(width - leftWidth - rightWidth);
    return { line: left + pad + right, rightVisible: true };
  }
  // Not enough room: truncate the right side; if none fits, omit it.
  const available = width - leftWidth - minPadding;
  if (available > 0) {
    const truncatedRight = truncate(right, available);
    const tw = visible(truncatedRight);
    const pad = " ".repeat(Math.max(0, width - leftWidth - tw));
    return { line: left + pad + truncatedRight, rightVisible: tw > 0 };
  }
  return { line: left, rightVisible: false };
}

/**
 * Compose the extension-statuses line with the cost segment right-aligned.
 * Returns null when there is nothing to show.
 */
export function composeStatusLine(
  statusTexts: string[],
  costSegment: string | null,
  width: number,
  visible: (s: string) => number,
): string | null {
  const statusLine = statusTexts.join(" ");
  if (!costSegment) {
    return statusLine.length > 0 ? statusLine : null;
  }
  const left = statusLine;
  const leftWidth = visible(left);
  const segWidth = visible(costSegment);
  const gap = 2;
  if (leftWidth + gap + segWidth <= width) {
    const pad = " ".repeat(Math.max(1, width - leftWidth - segWidth));
    return left + pad + costSegment;
  }
  // Not enough room for both on one line: keep statuses, drop the cost segment
  // (requirement: hide when there is no room).
  return left.length > 0 ? left : null;
}
