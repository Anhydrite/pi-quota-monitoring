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

## License

MIT

## Per-request cost readout (optional)

Toggle with `/quota-cost` (persisted in `~/.pi/agent/settings.json` under `quotaCost`). When ON, a second segment appears on the quota line, right-aligned (hidden automatically when the terminal is too narrow):

```
req ↑0.20 ↓0.98 R0.23 · moy $0.00103 · 0.0207%/10$
```

- `req` = last assistant request cost, split into `↑` input / `↓` output / `R` cache reads (thousandths of a cent when under a cent)
- `moy` = session average per request
- `%` = share of your paid plan (default `10$`) consumed by this session

The cost comes from the **real billed amount** returned by the Command Code gateway (`provider-metadata`), which includes peak-hour pricing and model-specific rates — no local catalog estimation. Requires the [pi-commandcode-provider](https://github.com/patlux/pi-commandcode-provider) `feat/real-api-cost` fork (or a release containing that change) for accurate real costs.
