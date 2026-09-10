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
  /**
   * What the subscription actually costs per month, in USD, as declared by the
   * user (`/quota-cost plan 10`). The API exposes the plan's usage allowance but
   * not its price, so the paid amount can only come from the user; without it
   * the real-cost part of the readout is omitted instead of guessed.
   */
  planMonthlyUsd?: number;
}

export const DEFAULT_CONFIG: QuotaCostConfig = { enabled: false };

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
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const cfg: QuotaCostConfig = {
      enabled: typeof obj.enabled === "boolean" ? obj.enabled : DEFAULT_CONFIG.enabled,
    };
    if (
      typeof obj.planMonthlyUsd === "number" &&
      Number.isFinite(obj.planMonthlyUsd) &&
      obj.planMonthlyUsd > 0
    ) {
      cfg.planMonthlyUsd = obj.planMonthlyUsd;
    }
    return cfg;
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
// Display
// ---------------------------------------------------------------------------

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
  // Sub-cent rates (cache reads): keep the significant digits, drop the padding.
  const four = v.toFixed(4).replace(/0+$/, "");
  return `$${four.endsWith(".") ? v.toFixed(5) : four}`;
}

/** Billed rates for one request, as recovered from the gateway's invoice. */
export interface DisplayRates {
  fresh: number;
  cache: number;
  output: number;
}

/**
 * Build the readout from the billed rates and, when the user has declared what
 * they pay, the same rates divided by the plan multiplier (credits per paid
 * dollar) so they read as money actually spent rather than credits consumed.
 *
 * Returns null when no rate is known: nothing is shown instead of a guess.
 */
export function rateSegmentCandidates(
  rates: DisplayRates | null,
  multiplier: number | null,
): string[] {
  if (!rates) return [];
  if (!(rates.fresh > 0) && !(rates.output > 0)) return [];
  const up = fmtPerM(rates.fresh);
  const down = fmtPerM(rates.output);
  // Cache reads are billed separately by the gateway, so their rate is a fact
  // too. Left out when no cache token was billed in this window.
  const cache = rates.cache > 0 ? ` R${fmtPerM(rates.cache)}/M` : "";
  const billed = `req ↑${up}/M ↓${down}/M${cache}`;
  const candidates: string[] = [];
  if (multiplier !== null && multiplier > 0) {
    const realCache = rates.cache > 0 ? ` R${fmtPerM(rates.cache / multiplier)}/M` : "";
    candidates.push(
      `${billed} · réel ↑${fmtPerM(rates.fresh / multiplier)}/M ↓${fmtPerM(rates.output / multiplier)}/M${realCache}`,
    );
  }
  candidates.push(billed);
  candidates.push(`↑${up}/M ↓${down}/M${cache}`);
  candidates.push(cache ? `↓${down}/M${cache}` : `↓${down}/M`);
  candidates.push(`↓${down}/M`);
  return candidates;
}

/**
 * The richest readout form, or null when no rate is known (nothing is shown
 * rather than a guess).
 */
export function buildRateSegment(
  rates: DisplayRates | null,
  multiplier: number | null,
): string | null {
  return rateSegmentCandidates(rates, multiplier)[0] ?? null;
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
export interface ComposedFooter {
  /** The status line to render (null when there is nothing at all). */
  statusLine: string | null;
  /** A dedicated line for the cost readout, when it could not share the status line. */
  ownCostLine: string | null;
}

/**
 * Compose the footer's status line with the cost readout.
 *
 * `costCandidates` is richest-first. The first candidate that can be shown wins,
 * whether it fits to the right of the statuses or needs its own line: showing a
 * richer fact on a dedicated line beats cramming a poorer one next to the
 * statuses. Only when nothing fits anywhere is the cost dropped.
 */
export function composeStatusLine(
  statusTexts: string[],
  costCandidates: readonly string[],
  width: number,
  visible: (s: string) => number,
): ComposedFooter {
  const statusLine = statusTexts.join(" ");
  const gap = 2;
  const leftWidth = visible(statusLine);

  for (const candidate of costCandidates) {
    const segWidth = visible(candidate);
    if (leftWidth + gap + segWidth <= width) {
      const pad = " ".repeat(Math.max(1, width - leftWidth - segWidth));
      return { statusLine: statusLine + pad + candidate, ownCostLine: null };
    }
    if (segWidth <= width) {
      return { statusLine: statusLine.length > 0 ? statusLine : null, ownCostLine: candidate };
    }
  }
  return { statusLine: statusLine.length > 0 ? statusLine : null, ownCostLine: null };
}
