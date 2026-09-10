/**
 * index — extension wiring for the pi-quota-monitoring request-cost option.
 *
 * Pure helpers live in request-cost.ts; this module wires them into pi:
 *   - collects per-request real cost on message_end
 *   - when enabled, replaces the footer with a replica of pi's default footer
 *     plus the cost segment right-aligned on the extension-statuses line
 *     (hidden when the terminal is too narrow)
 *   - /quota-cost command toggles the readout (persisted in settings.json)
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  MessageEndEvent,
  Model,
  SessionEntry,
  Usage,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import {
  buildPwdLine,
  buildStatsLine,
  composeStatusLine,
  loadConfig,
  rateSegmentCandidates,
  saveConfig,
} from "./request-cost.ts";
import { planMultiplier, RateLedger } from "./rate-ledger.ts";


type FooterTheme = ReturnType<ExtensionContext["ui"] extends never ? never : never>;

/** Mirror of the extension's allowance so the pure footer renderer can use it. */
let lastKnownAllowanceUsd: number | null = null;

class RequestCostExtension {
  private ctx: ExtensionContext | null = null;
  private tui: TUI | null = null;
  /** Billed rates recovered from the gateway's own invoices, per model. */
  private ledger = new RateLedger();
  private config: QuotaCostConfig = { enabled: false };
  private footerActive = false;
  /**
   * Plan usage allowance in USD, read from the API (remaining monthly credits
   * plus what the period already consumed). Only used with the user-declared
   * plan price to turn billed credits into money actually spent.
   */
  private allowanceUsd: number | null = null;
  private allowanceFetchedAt = 0;

  async sync(ctx: ExtensionContext): Promise<void> {
    this.ctx = ctx;
    this.config = await loadConfig();
    await this.refreshAllowance(ctx);
    this.applyFooter();
    this.publishStatus();
  }

  /** Reads the plan's usage allowance from the API (facts only, no price). */
  private async refreshAllowance(ctx: ExtensionContext): Promise<void> {
    try {
      const apiKey = await ctx.modelRegistry?.getApiKeyForProvider?.("commandcode");
      if (!apiKey) return;
      const headers = { accept: "application/json", Authorization: `Bearer ${apiKey}` };
      const signal = AbortSignal.timeout(10_000);
      const [creditsRes, usageRes] = await Promise.all([
        fetch("https://api.commandcode.ai/alpha/billing/credits", { headers, signal }),
        fetch("https://api.commandcode.ai/alpha/usage/summary", { headers, signal }),
      ]);
      if (!creditsRes.ok || !usageRes.ok) return;
      const credits = (await creditsRes.json()) as { credits?: { monthlyCredits?: number } };
      const usage = (await usageRes.json()) as { totalCost?: number };
      const remaining = credits.credits?.monthlyCredits;
      const used = usage.totalCost;
      if (typeof remaining === "number" && typeof used === "number" && remaining + used > 0) {
        this.allowanceUsd = remaining + used;
        lastKnownAllowanceUsd = this.allowanceUsd;
        this.allowanceFetchedAt = Date.now();
      }
    } catch {
      /* allowance is optional: without it the real-cost part is omitted */
    }
  }

  /** Credits per paid dollar: API allowance divided by the declared plan price. */
  private multiplier(): number | null {
    return planMultiplier(this.config.planMonthlyUsd, this.allowanceUsd ?? undefined);
  }

  /** Records what the user pays per month (the API exposes no plan price). */
  async setPlanPrice(planMonthlyUsd: number): Promise<void> {
    this.config = await saveConfig({ planMonthlyUsd });
    this.publishStatus();
    this.requestRender();
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.config = await saveConfig({ enabled });
    if (enabled) {
      this.applyFooter();
      this.publishStatus();
    } else {
      this.clearFooterAndStatus();
    }
  }

  private clearFooterAndStatus(): void {
    try {
      this.ctx?.ui.setFooter(undefined);
      this.ctx?.ui.setStatus("zz-cost", undefined);
    } catch {
      /* stale ctx */
    }
    this.tui = null;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  handleMessageEnd(event: MessageEndEvent): void {
    if (event.message.role !== "assistant") return;
    const m = event.message as { provider?: string; model?: string; usage?: Usage };
    const provider = (m.provider ?? "").toLowerCase();
    if (provider !== "commandcode" && provider !== "opencode-go" && provider !== "opencode") return;
    if (!this.ledger.record(m.usage ?? {}, m.model ?? this.currentModelId())) return;
    this.publishStatus();
    this.requestRender();
    // Keep the allowance fresh without polling the API on every request.
    if (this.ctx && Date.now() - this.allowanceFetchedAt > 5 * 60_000) {
      void this.refreshAllowance(this.ctx)
    }
  }

  private currentModelId(): string {
    const model = this.ctx?.model as { id?: string } | undefined;
    return model?.id ?? "unknown";
  }

  /**
   * Publish the cost segment as an extension status ("zz-cost"). The default
   * footer always renders extension statuses on its third line, so the readout
   * survives TUI re-renders and interrupts even if the custom footer is ever
   * replaced; the custom footer (when active) also composes it right-aligned.
   */
  private publishStatus(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const segment =
      rateSegmentCandidates(this.ledger.currentRates(), this.multiplier())[0] ?? null;
    try {
      ctx.ui.setStatus("zz-cost", segment ?? undefined);
    } catch {
      /* stale ctx */
    }
  }

  private requestRender(): void {
    try {
      this.tui?.requestRender();
    } catch {
      /* best-effort */
    }
  }

  private applyFooter(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.footerActive = this.config.enabled;
    try {
      if (!this.config.enabled) {
        ctx.ui.setFooter(undefined);
        this.tui = null;
        return;
      }
      ctx.ui.setFooter((tui, theme, footerData) => {
        this.tui = tui;
        // `render` must capture the extension state via an arrow closure:
        // a plain method on this object literal would rebind `this` to the
        // literal and `this.state` would be undefined.
        return {
          invalidate() {},
          render: (width: number): string[] =>
            renderFooter(ctx, theme, footerData, this.ledger, this.config, width),
          dispose: footerData.onBranchChange(() => tui.requestRender()),
        };
      });
    } catch {
      /* stale ctx */
    }
  }
}

// ---------------------------------------------------------------------------
// Footer rendering
// ---------------------------------------------------------------------------

interface FooterDataLike {
  getGitBranch(): string | null;
  getExtensionStatuses(): ReadonlyMap<string, string>;
  getAvailableProviderCount(): number;
  onBranchChange(cb: () => void): () => void;
}

function computeUsageTotals(entries: SessionEntry[]): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
} {
  let input = 0,
    output = 0,
    cacheRead = 0,
    cacheWrite = 0,
    cost = 0;
  for (const entry of entries) {
    let usage: Usage | undefined;
    if (entry.type === "message" && entry.message.role === "assistant") {
      usage = (entry.message as { usage?: Usage }).usage;
    } else if (entry.type === "message" && entry.message.role === "toolResult") {
      usage = (entry.message as { usage?: Usage }).usage;
    } else if (
      (entry.type === "branch_summary" || entry.type === "compaction") &&
      (entry as { usage?: Usage }).usage
    ) {
      usage = (entry as { usage?: Usage }).usage;
    }
    if (!usage) continue;
    input += usage.input ?? 0;
    output += usage.output ?? 0;
    cacheRead += usage.cacheRead ?? 0;
    cacheWrite += usage.cacheWrite ?? 0;
    cost += usage.cost?.total ?? 0;
  }
  return { input, output, cacheRead, cacheWrite, cost };
}

function latestCacheHitRate(entries: SessionEntry[]): number | null {
  let rate: number | null = null;
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const u = (entry.message as { usage?: Usage }).usage;
    if (!u) continue;
    const promptTokens = u.input + u.cacheRead + u.cacheWrite;
    if (promptTokens > 0) rate = (u.cacheRead / promptTokens) * 100;
  }
  return rate;
}

function getModelLabel(model: Model<unknown> | undefined): {
  modelId: string;
  provider: string | null;
  reasoning: boolean;
  thinkingLevel: string | null;
} {
  if (!model) return { modelId: "no-model", provider: null, reasoning: false, thinkingLevel: null };
  return {
    modelId: model.id,
    provider: model.provider ?? null,
    reasoning: Boolean(model.reasoning),
    thinkingLevel: null,
  };
}

/**
 * Theme-aware footer renderer. Wrapped defensively: a transient extension
 * error during a TUI re-render (e.g. after an interrupt) must never blank the
 * footer — we degrade to minimal lines instead.
 */
function renderFooter(
  ctx: ExtensionContext,
  theme: { fg(color: string, text: string): string },
  footerData: FooterDataLike,
  ledger: RateLedger,
  config: QuotaCostConfig,
  width: number,
): string[] {
  try {
    return renderFooterInner(ctx, theme, footerData, ledger, config, width);
  } catch (err) {
    // Never take the whole footer down on a transient render error.
    try {
      console.error("[quota-cost] footer render error:", err);
    } catch {
      /* ignore */
    }
    // Fallback: render at least the raw extension statuses so the footer
    // never blanks out (avoids the readout "disappearing" after interrupts).
    try {
      const statuses = Array.from(footerData.getExtensionStatuses().values())
        .map((s) => sanitize(s))
        .filter(Boolean);
      if (statuses.length > 0) {
        return [truncateToWidth(theme.fg("dim", statuses.join(" ")), width, theme.fg("dim", "..."))];
      }
    } catch {
      /* ignore */
    }
    return [];
  }
}

function renderFooterInner(
  ctx: ExtensionContext,
  theme: { fg(color: string, text: string): string },
  footerData: FooterDataLike,
  ledger: RateLedger,
  config: QuotaCostConfig,
  width: number,
): string[] {
  const sm = ctx.sessionManager as unknown as {
    getEntries(): SessionEntry[];
    getCwd(): string;
    getSessionName(): string | null;
  };
  const entries = sm.getEntries();
  const totals = computeUsageTotals(entries);
  const rate = latestCacheHitRate(entries);
  const contextUsage = ctx.getContextUsage?.();
  const model = getModelLabel(ctx.model);

  const dim = (s: string) => theme.fg("dim", s);
  const warning = (s: string) => theme.fg("warning", s);
  const error = (s: string) => theme.fg("error", s);

  const sm2 = sm;
  const cwdLine = truncateToWidth(
    dim(
      buildPwdLine({
        cwd: sm2.getCwd(),
        branch: footerData.getGitBranch(),
        sessionName: sm2.getSessionName(),
        usageInput: 0, usageOutput: 0, usageCacheRead: 0, usageCacheWrite: 0, usageCost: 0,
        latestCacheHitRate: null, contextPercent: null, contextWindow: 0,
        modelId: "", modelProvider: null, modelReasoning: false, thinkingLevel: null,
        providerCount: 0, autoCompactEnabled: false, experimental: false,
      }),
    ),
    width,
    dim("..."),
  );

  const { statsLeft, rightSide } = buildStatsLine({
    cwd: sm2.getCwd(), branch: null, sessionName: null,
    usageInput: totals.input, usageOutput: totals.output,
    usageCacheRead: totals.cacheRead, usageCacheWrite: totals.cacheWrite,
    usageCost: totals.cost, latestCacheHitRate: rate,
    contextPercent: contextUsage?.percent ?? null,
    contextWindow: contextUsage?.contextWindow ?? 0,
    modelId: model.modelId, modelProvider: model.provider,
    modelReasoning: model.reasoning, thinkingLevel: model.thinkingLevel,
    providerCount: footerData.getAvailableProviderCount(),
    autoCompactEnabled: true, experimental: false,
  });

  // Colorize the context % part like pi (error >90, warning >70).
  const ctxPct = contextUsage?.percent;
  const coloredLeft = statsLeft.replace(
    /(\d+(?:\.\d+)?%\/[\d.]+[kM]?(?: \(auto\))?)/,
    (_m, p) => (ctxPct === null || ctxPct === undefined ? p : ctxPct > 90 ? error(p) : ctxPct > 70 ? warning(p) : p),
  );
  const statsWidth = visibleWidth(coloredLeft);
  const rightStr = theme.fg("dim", rightSide);
  const rightWidth = visibleWidth(rightStr);
  let statsLine: string;
  if (statsWidth + 2 + rightWidth <= width) {
    statsLine = dim(coloredLeft) + " ".repeat(Math.max(0, width - statsWidth - rightWidth)) + rightStr;
  } else {
    statsLine = truncateToWidth(dim(coloredLeft), width, dim("..."));
  }

  // Line 3: extension statuses (quotas) + cost segment right-aligned.
  // Drop the "zz-cost" status (published for the default footer) so it is not
  // shown twice: the custom footer composes it as the right-aligned segment.
  const statuses = Array.from(footerData.getExtensionStatuses().entries())
    .filter(([key]) => key !== "zz-cost")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, text]) => sanitize(text));
  const candidates = rateSegmentCandidates(
    ledger.currentRates(),
    planMultiplier(config.planMonthlyUsd, lastKnownAllowanceUsd),
  );
  const themed = candidates.map((c) => theme.fg("accent", c));
  const composed = composeStatusLine(statuses, themed, width, visibleWidth);

  const lines = [cwdLine, statsLine];
  if (composed.statusLine) {
    lines.push(truncateToWidth(composed.statusLine, width, theme.fg("dim", "...")));
  }
  // No room beside the quotas: the readout gets its own (compacted) line rather
  // than disappearing.
  if (composed.ownCostLine) lines.push(composed.ownCostLine);
  return lines;
}

function sanitize(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

const ext = new RequestCostExtension();

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("quota-cost", {
    description: "Toggle the billed-rate readout, or declare the plan price: /quota-cost [on|off|plan <usd>]",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim();
      const planMatch = /^plan\s+([0-9]+(?:\.[0-9]+)?)$/i.exec(arg);
      if (planMatch) {
        const usd = Number(planMatch[1]);
        await ext.setPlanPrice(usd);
        ctx.ui.notify(
          `Plan price set to $${usd}/month — the readout now also shows what each rate costs you after the plan multiplier.`,
          "info",
        );
        return;
      }
      if (arg && !/^(on|off)$/i.test(arg)) {
        ctx.ui.notify(
          "Usage: /quota-cost [on|off] to toggle, or /quota-cost plan <monthly usd> to declare what you pay.",
          "warning",
        );
        return;
      }
      const next = arg ? /^on$/i.test(arg) : !ext.isEnabled();
      await ext.setEnabled(next);
      ctx.ui.notify(
        next ? "Per-request cost readout ON" : "Per-request cost readout OFF",
        "info",
      );
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await ext.sync(ctx);
  });
  pi.on("model_select", async (_event, ctx) => {
    await ext.sync(ctx);
  });
  pi.on("message_end", (event) => {
    ext.handleMessageEnd(event);
  });
  pi.on("session_shutdown", () => {
    ext.setEnabled(ext.isEnabled()); // no-op safety; footer cleared by pi on shutdown
  });
}
