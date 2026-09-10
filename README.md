# pi-quota-monitoring

[![npm version](https://img.shields.io/npm/v/pi-quota-monitoring.svg)](https://www.npmjs.com/package/pi-quota-monitoring)

A [pi](https://pi.dev) extension that shows your **subscription quota usage (%)** in the status bar.

## Package

Available on npm: **<https://www.npmjs.com/package/pi-quota-monitoring>**

```bash
npm view pi-quota-monitoring   # see the published package
```

Supported providers:

| Provider | Label | Quota source |
| --- | --- | --- |
| [Command Code](https://commandcode.ai) (`commandcode`) | `CC` | `api.commandcode.ai` billing period + 5h window |
| [OpenCode Go](https://opencode.ai) (`opencode-go`) | `OG` | `opencode.ai/zen/go/v1/usage` rolling window |

The quota only appears when you're using a model from a supported provider. Switch to any other provider (e.g. `minimax`) and the display clears automatically.

## What it looks like

In the pi footer, the extension shows one segment per usage window:

```
CC 5h: 15% resets in 2h · mois: 3% resets in 4d
OG 5h: 10% resets in 2h · mois: 27% resets in 13d
```

If you also have [pi-token-speed](https://github.com/gsanhueza/pi-token-speed) installed, the quota appears to the **right of your TPS** readout (the `zz-quota` status key sorts right after `tokenSpeed`).

- **Two windows shown**: the **5-hour** window (tighter limit, with reset countdown) and the **monthly** billing period
- **Color-coded**: green (ok), yellow (≥70% used), red (≥90% used)
- **Reset countdown**: each window shows `resets in 2h` / `5m` / `1d` until it resets - the 5h window uses the provider's real reset timestamp; the monthly window uses the provider's reset timestamp when available (OpenCode Go), otherwise the next calendar-month start (Command Code)
- **Auto-refresh**: every 60s and after every agent turn
- **Command Code** shows the 5-hour window + monthly billing-period total
- **OpenCode Go** shows the rolling (≈5h) + monthly windows

## Install

```bash
pi install npm:pi-quota-monitoring
```

Then `/reload` or restart pi.

## Usage

Nothing to configure. Pick a model from a supported provider and the quota shows up in the footer.

## How it works

The extension reads the API key from pi's model registry (falling back to the standard auth stores), then queries each provider's usage endpoint:

- **Command Code**: `GET https://api.commandcode.ai/alpha/whoami` → `GET /alpha/billing/credits` + `GET /alpha/usage/summary` - computes the 5-hour window percentage and the monthly billing-period percentage (`used / total`).
- **OpenCode Go**: `GET https://opencode.ai/zen/go/v1/usage` - the API returns `rolling` (≈5h) and `monthly` percentages directly.

The status is set under the key `zz-quota`, which sorts alphabetically just after `tokenSpeed` in pi's footer (when [pi-token-speed](https://github.com/gsanhueza/pi-token-speed) is installed), placing the quota to the **right** of the TPS display.

## Per-request cost readout (optional)

Toggle with `/quota-cost` (persisted in `~/.pi/agent/settings.json` under `quotaCost`). When ON, a segment appears on the quota line, right-aligned (hidden automatically when the terminal is too narrow):

```
req ↑$0.300/M ↓$1.20/M R$0.006/M · réel ↑$0.043/M ↓$0.171/M R$0.0009/M
```

- `req ↑` / `↓` / `R` = the **billed** rate per million tokens for fresh input, output, and cache reads, for the price window your last request was billed in
- `réel ↑` / `↓` / `R` = the same rates divided by your plan multiplier, i.e. what that usage actually costs you out of the money you paid

### Where the rates come from

Not from a table. The Command Code API publishes no rate card — it reports, per request, the amount it billed (`inputInferenceCost`, `outputInferenceCost`) plus token counts. The rates are recovered from those invoices alone:

- output is billed at a single per-token rate, so `outputCost ÷ outputTokens` is the output rate of that request;
- the gateway bills one input-side amount covering fresh tokens *and* cache reads, so `inputCost = fresh × rFresh + cache × rCache`. Two unknown rates, solved by least squares over your own requests, which have varied mixes.

Requests are grouped by the output rate the gateway billed, so a change of price window (peak/off-peak) is detected the moment it is billed — no calendar and no price list is embedded. Rates are per model.

Practical consequences:

- the numbers are facts, and they follow a price change automatically. A real
  session was billed under **three** rate lists in one day (`$0.22/$0.66/$0.007`,
  then `$0.30/$1.20/$0.006` peak, then `$0.15/$0.60/$0.003`); each is detected
  separately, and within one list peak is an exact ×2 on all three rates. Applying
  a ×2 rule to the *previous* list would have produced a wrong figure
- the first request or two of a window show **nothing** while the input side is still unsolvable — no estimate is displayed
- the readout **degrades instead of disappearing** on a narrow terminal: it drops the
  real-cost part, then the fresh rate, then moves to its own line, and finally keeps
  only `↓<rate>/M`. A fact stays on screen at any width

### The real cost of your subscription

`réel` = billed rates ÷ plan multiplier, where the multiplier is `API allowance ÷ what you pay`, both in USD:

- **allowance** comes from the API (`/alpha/billing/credits` remaining monthly credits + `/alpha/usage/summary` consumed this period);
- **what you pay** cannot come from the API — there is no plan-price endpoint, only a `planId`. Declare it once:

```
/quota-cost plan 10        (your monthly subscription price, in USD)
```

Without it the readout shows only the billed rates; nothing is assumed.

### Tests

```sh
npm test        # node --test "tests/*.test.ts"
```

`tests/rate-ledger.test.ts` pins the recovery, the peak/off-peak grouping, and the
degradation ladder (including the negative cases: an unsolvable mix or an unbilled
request must render nothing). `tests/request-cost.test.ts` fails if a rate card, a
model id, or an assumed plan price ever reappears in the sources.

## License

MIT
