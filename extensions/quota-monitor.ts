import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// pi-quota-monitoring — status-bar quota monitor for pi
// ---------------------------------------------------------------------------
// Shows the current subscription usage percentage in the pi status bar for
// quota-aware providers, ONLY when a model from one of those providers is
// active. Supported providers:
//
//   • commandcode  (Command Code)  → api.commandcode.ai   → CC 23%
//   • opencode-go  (OpenCode Go)   → opencode.ai          → OG 27%
//
// The status key ("zz-quota") sorts AFTER "tokenSpeed" (a status set by the
// optional pi-token-speed package), so when that package is installed the
// quota appears to the RIGHT of its TPS readout in the footer.
// footer. The display clears automatically when you switch to a model whose
// provider has no quota endpoint.
// ---------------------------------------------------------------------------

const STATUS_KEY = "zz-quota";

const REFRESH_INTERVAL_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;

// Percentage thresholds for color coding
const WARNING_PCT = 70;
const CRITICAL_PCT = 90;

interface ProviderSpec {
  /** Provider id in pi's model registry (ctx.model.provider) */
  provider: string;
  /** Short label shown in the status bar */
  label: string;
  /** API base URL */
  baseUrl: string;
}

const PROVIDERS: Record<string, ProviderSpec> = {
  commandcode: {
    provider: "commandcode",
    label: "CC",
    baseUrl: "https://api.commandcode.ai",
  },
  "opencode-go": {
    provider: "opencode-go",
    label: "OG",
    baseUrl: "https://opencode.ai/zen/go/v1",
  },
};

// ---------------------------------------------------------------------------
// Quota fetch logic
// ---------------------------------------------------------------------------

interface QuotaSegment {
  /** Short window label, e.g. "5h" or "mois" */
  label: string;
  /** Percent used (0-100). May be fractional. */
  percent: number;
  /** Optional short reset countdown suffix, e.g. " 2h" */
  resetSuffix: string;
}

interface QuotaData {
  segments: QuotaSegment[];
}

async function fetchJson(
  url: string,
  apiKey: string,
  timeoutMs: number,
): Promise<unknown | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json", Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function fmtReset(epochSeconds: number | null): string {
  if (!epochSeconds) return "";
  const diffMs = epochSeconds * 1000 - Date.now();
  if (diffMs <= 0) return "";
  const minutes = Math.ceil(diffMs / 60_000);
  if (minutes < 60) return ` resets in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return ` resets in ${hours}h`;
  return ` resets in ${Math.floor(hours / 24)}d`;
}

/** Normalize a raw reset timestamp (epoch seconds, epoch ms, or ISO string) to epoch seconds. */
function toEpochSeconds(value: number | string | null | undefined): number | null {
  if (value == null) return null;
  if (typeof value === "number") return value > 1e12 ? Math.round(value / 1000) : value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : Math.round(parsed / 1000);
}

/** Estimate the next calendar-month start (Command Code monthly credits reset on the 1st). */
function nextMonthStartEpoch(): number {
  const now = new Date();
  return Math.floor(new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0).getTime() / 1000);
}

/** Command Code: credits + usage summary → 5h window and monthly billing period. */
async function fetchCommandCodeQuota(apiKey: string, timeoutMs: number): Promise<QuotaData | null> {
  const base = PROVIDERS.commandcode.baseUrl;

  const whoami = (await fetchJson(`${base}/alpha/whoami`, apiKey, timeoutMs)) as
    | { org?: { id?: string } | null }
    | null;
  if (!whoami) return null;

  const orgId = whoami.org?.id;
  const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";

  const credits = (await fetchJson(`${base}/alpha/billing/credits${qs}`, apiKey, timeoutMs)) as
    | {
        credits?: {
          monthlyCredits?: number;
          purchasedCredits?: number;
          freeCredits?: number;
          monthlyResetAt?: number | string;
        };
        windowLimits?: {
          fiveHour?: { used: number; cap: number; resetAt?: number };
          weekly?: { used: number; cap: number; resetAt?: number };
        };
      }
    | null;

  const summary = (await fetchJson(`${base}/alpha/usage/summary${qs}`, apiKey, timeoutMs)) as
    | { totalCost?: number }
    | null;

  const monthly = credits?.credits?.monthlyCredits ?? 0;
  const purchased = credits?.credits?.purchasedCredits ?? 0;
  const free = credits?.credits?.freeCredits ?? 0;
  const remaining = monthly + purchased + free;
  const spent = summary?.totalCost ?? 0;
  const total = remaining + spent;

  const segments: QuotaSegment[] = [];

  // 5-hour window (the tighter limit).
  const fiveHour = credits?.windowLimits?.fiveHour;
  if (fiveHour && fiveHour.cap > 0) {
    const pct = (fiveHour.used / fiveHour.cap) * 100;
    segments.push({ label: "5h", percent: pct, resetSuffix: fmtReset(toEpochSeconds(fiveHour.resetAt)) });
  }

  // Monthly billing period (spent / total for the month).
  if (total > 0) {
    // The billing API only exposes a reset timestamp for the 5h window, so
    // fall back to the next calendar-month start for the monthly bucket
    // (unless a monthlyResetAt ever shows up in the response).
    const monthlyReset = toEpochSeconds(credits?.credits?.monthlyResetAt) ?? nextMonthStartEpoch();
    segments.push({ label: "mois", percent: (spent / total) * 100, resetSuffix: fmtReset(monthlyReset) });
  }

  if (segments.length === 0)
    return { segments: [{ label: "mois", percent: 0, resetSuffix: fmtReset(nextMonthStartEpoch()) }] };
  return { segments };
}

/** OpenCode Go: /usage returns rolling (≈5h) and monthly percentages directly. */
async function fetchOpenCodeGoQuota(
  apiKey: string,
  timeoutMs: number,
): Promise<QuotaData | null> {
  const base = PROVIDERS["opencode-go"].baseUrl;
  const raw = (await fetchJson(`${base}/usage`, apiKey, timeoutMs)) as
    | {
        usage?: {
          rolling?: { percent?: number; resetsAt?: string };
          weekly?: { percent?: number; resetsAt?: string };
          monthly?: { percent?: number; resetsAt?: string };
        };
      }
    | null;

  const usage = raw?.usage;
  if (!usage) return null;

  const segments: QuotaSegment[] = [];

  // Rolling window ≈ 5 hours → shown as "5h".
  if (usage.rolling && typeof usage.rolling.percent === "number") {
    const resetEpoch = toEpochSeconds(usage.rolling.resetsAt);
    segments.push({ label: "5h", percent: usage.rolling.percent, resetSuffix: fmtReset(resetEpoch) });
  }

  // Monthly window.
  if (usage.monthly && typeof usage.monthly.percent === "number") {
    const resetEpoch = toEpochSeconds(usage.monthly.resetsAt);
    segments.push({ label: "mois", percent: usage.monthly.percent, resetSuffix: fmtReset(resetEpoch) });
  }

  if (segments.length === 0) return null;
  return { segments };
}

// ---------------------------------------------------------------------------
// Extension state
// ---------------------------------------------------------------------------

type TimerHandle = ReturnType<typeof setInterval>;

class QuotaMonitor {
  private ctx: ExtensionContext | null = null;
  private timer: TimerHandle | null = null;

  /** Re-arm the display for the current model with a FRESH context. */
  sync(ctx: ExtensionContext): void {
    // A new session_start (startup/reload/new/resume/fork) replaces the
    // session; the previous ctx would be stale and crash on any access.
    this.ctx = ctx;
    const spec = this.currentSpec();
    if (spec) {
      void this.refresh().catch(() => this.clearStatus());
      this.ensureTimer();
    } else {
      this.clear();
    }
  }

  clear(): void {
    this.stopTimer();
    this.clearStatus();
  }

  /** Clear the status entry without touching a possibly-stale ctx. */
  private clearStatus(): void {
    try {
      this.ctx?.ui.setStatus(STATUS_KEY, undefined);
    } catch {
      // ctx is stale (reload happened) — nothing to clear on this ctx.
    }
  }

  dispose(): void {
    this.clear();
  }

  private currentSpec(): ProviderSpec | null {
    const provider = this.ctx?.model?.provider;
    return provider ? (PROVIDERS[provider] ?? null) : null;
  }

  private ensureTimer(): void {
    if (this.timer) return;
    const timer = setInterval(() => {
      if (this.currentSpec()) void this.refresh().catch(() => this.clearStatus());
      else this.clear();
    }, REFRESH_INTERVAL_MS);
    // In Node, unref() lets the process exit even while the timer is pending.
    if (typeof timer === "object" && timer && "unref" in timer) timer.unref();
    this.timer = timer;
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async getApiKey(provider: string): Promise<string | undefined> {
    try {
      const registryKey = await this.ctx?.modelRegistry?.getApiKeyForProvider?.(provider);
      if (registryKey) return registryKey;
    } catch {
      // fall through to file-based lookup
    }

    // Fallback: read from the auth stores like the bridge providers do.
    try {
      const { homedir } = await import("node:os");
      const { readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const home = homedir();
      const paths = [
        join(home, ".pi", "agent", "auth.json"),
        join(home, ".local", "share", "opencode", "auth.json"),
        join(home, ".commandcode", "auth.json"),
        join(home, ".omp", "agent", "auth.json"),
      ];
      for (const p of paths) {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
        } catch {
          continue;
        }
        // Flat string key (auth.json: { commandcode: "..." } or { opencode-go: "..." })
        if (typeof parsed[provider] === "string" && parsed[provider]) {
          return parsed[provider] as string;
        }
        // apiKey flat field
        if (typeof parsed.apiKey === "string" && parsed.apiKey) return parsed.apiKey;
        // Nested credential objects ({ provider: { type, key|access } })
        const cred = parsed[provider] as Record<string, unknown> | undefined;
        if (cred && typeof cred === "object") {
          if (typeof cred.access === "string" && cred.access) return cred.access;
          if (typeof cred.key === "string" && cred.key) return cred.key;
        }
      }
    } catch {
      // not readable — caller will show nothing
    }
    return undefined;
  }

  async refresh(): Promise<void> {
    const ctx = this.ctx;
    const spec = this.currentSpec();
    if (!ctx || !spec) return;

    let theme;
    try {
      theme = ctx.ui.theme;
    } catch {
      // ctx is stale (reload happened between sync() and this refresh) —
      // bail out silently instead of crashing pi.
      return;
    }

    const apiKey = await this.getApiKey(spec.provider);
    if (!apiKey) {
      this.safeSetStatus(ctx, undefined);
      return;
    }

    const data =
      spec.provider === "commandcode"
        ? await fetchCommandCodeQuota(apiKey, FETCH_TIMEOUT_MS)
        : await fetchOpenCodeGoQuota(apiKey, FETCH_TIMEOUT_MS);

    if (!data) {
      // Don't clutter the footer on transient failures.
      this.safeSetStatus(ctx, undefined);
      return;
    }

    const text = `${theme.fg("dim", spec.label)} ${data.segments
      .map((seg) => {
        const pct = Math.round(seg.percent);
        let color: "success" | "warning" | "error" = "success";
        if (pct >= CRITICAL_PCT) color = "error";
        else if (pct >= WARNING_PCT) color = "warning";
        return `${theme.fg("dim", `${seg.label}:`)} ${theme.fg(color, `${pct}%`)}${theme.fg("dim", seg.resetSuffix)}`;
      })
      .join(theme.fg("dim", " · "))}`;
    this.safeSetStatus(ctx, text);
  }

  /** setStatus that never throws, even if the ctx became stale mid-flight. */
  private safeSetStatus(ctx: ExtensionContext, text: string | undefined): void {
    try {
      ctx.ui.setStatus(STATUS_KEY, text);
    } catch {
      // stale ctx — the next session_start will re-arm with a fresh one.
    }
  }
}

const monitor = new QuotaMonitor();

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // Show quota at session start (and on /new) when a supported model is active.
  pi.on("session_start", (_event, ctx) => {
    monitor.sync(ctx);
  });

  // React immediately when the user switches models.
  pi.on("model_select", (_event, ctx) => {
    monitor.sync(ctx);
  });

  // Refresh when the agent finishes a turn, so the % tracks actual usage.
  pi.on("agent_end", (_event, ctx) => {
    if (ctx.model?.provider && PROVIDERS[ctx.model.provider]) {
      // agent_end gives a fresh ctx — re-arm from it so a reload that
      // happened between events doesn't leave us holding a stale one.
      monitor.sync(ctx);
    }
  });

  pi.on("session_shutdown", () => {
    monitor.dispose();
  });
}
