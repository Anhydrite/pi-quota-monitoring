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
  buildCostSegment,
  buildPwdLine,
  buildStatsLine,
  composeStatusLine,
  createCostState,
  ingestUsage,
  loadConfig,
  resolvePlan,
  saveConfig,
} from "./request-cost.ts";
// Default paid plan assumption when auto-detection is unavailable (GOAT is
// the most common $10 plan; auto-detection corrects it from the API).
const PLAN_USD = 10;


type FooterTheme = ReturnType<ExtensionContext["ui"] extends never ? never : never>;

class RequestCostExtension {
  private ctx: ExtensionContext | null = null;
  private tui: TUI | null = null;
  private state: CostState = createCostState();
  private config: QuotaCostConfig = { enabled: false };
  private footerActive = false;
  /** Resolved plan: multiplier (credits per paid $) and paid plan amount. */
  private plan = { multiplier: 1, costUsd: PLAN_USD };

  async sync(ctx: ExtensionContext): Promise<void> {
    this.ctx = ctx;
    this.config = await loadConfig();
    this.state = createCostState();
    await this.resolvePlanFromApi(ctx);
    this.applyFooter();
  }

  private async resolvePlanFromApi(ctx: ExtensionContext): Promise<void> {
    try {
      const apiKey = await ctx.modelRegistry?.getApiKeyForProvider?.("commandcode");
      const resolved = await resolvePlan({
        apiKey,
        configOverride: this.config.creditMultiplier,
      });
      this.plan = {
        multiplier: resolved.multiplier,
        costUsd: resolved.costUsd > 0 ? resolved.costUsd : PLAN_USD,
      };
    } catch {
      this.plan = { multiplier: 1, costUsd: PLAN_USD };
    }
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.config = await saveConfig({ enabled });
    this.applyFooter();
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  handleMessageEnd(event: MessageEndEvent): void {
    if (event.message.role !== "assistant") return;
    const m = event.message as { provider?: string; usage?: Usage };
    if (ingestUsage(this.state, m.provider, m.usage)) {
      this.requestRender();
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
            renderFooter(ctx, theme, footerData, this.state, this.plan, width),
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

/** Theme-aware footer renderer. */
function renderFooter(
  ctx: ExtensionContext,
  theme: { fg(color: string, text: string): string },
  footerData: FooterDataLike,
  state: CostState,
  plan: { multiplier: number; costUsd: number },
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
  const statuses = Array.from(footerData.getExtensionStatuses().entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, text]) => sanitize(text));
  const costSegment = buildCostSegment(state, {
    planUsd: plan.costUsd,
    creditMultiplier: plan.multiplier,
  });
  const segStr = costSegment ? theme.fg("accent", costSegment) : null;
  const statusLineRaw = composeStatusLine(statuses, segStr, width, visibleWidth);

  const lines = [cwdLine, statsLine];
  if (statusLineRaw) {
    lines.push(truncateToWidth(statusLineRaw, width, theme.fg("dim", "...")));
  }
  return lines;
}

function sanitize(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

const ext = new RequestCostExtension();

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("quota-cost", {
    description: "Toggle per-request cost readout (right-aligned in footer)",
    handler: async (_args, ctx) => {
      const next = !ext.isEnabled();
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
