# pi-quota-monitoring

A [pi](https://pi.dev) extension that shows your **subscription quota usage (%)** in the status bar — right next to your TPS readout.

Supported providers:

| Provider | Label | Quota source |
| --- | --- | --- |
| [Command Code](https://commandcode.ai) (`commandcode`) | `CC` | `api.commandcode.ai` billing period + 5h window |
| [OpenCode Go](https://opencode.ai) (`opencode-go`) | `OG` | `opencode.ai/zen/go/v1/usage` rolling window |

The quota only appears when you're using a model from a supported provider. Switch to any other provider (e.g. `minimax`) and the display clears automatically.

## What it looks like

In the pi footer, next to your TPS (from [pi-token-speed](https://github.com/gsanhueza/pi-token-speed)):

```
CC 13% 2h   ⚡ TPS: 42.1 tok/s
OG 10% 2h   ⚡ TPS: 42.1 tok/s
```

- **Color-coded**: green (ok), yellow (≥70% used), red (≥90% used)
- **Reset countdown**: shows the time until the active usage window resets (`2h`, `5m`, `1d`)
- **Auto-refresh**: every 60s and after every agent turn
- **Command Code** uses the tighter 5-hour window when available, else the billing-period total
- **OpenCode Go** uses the tightest available window: rolling → weekly → monthly

## Install

```bash
pi install git:github.com/Anhydrite/pi-quota-monitoring
```

Then `/reload` or restart pi.

## Usage

Nothing to do — it just works. Pick a model from a supported provider and the quota appears in the footer.

## How it works

The extension reads the API key from pi's model registry (falling back to the standard auth stores), then queries each provider's usage endpoint:

- **Command Code**: `GET https://api.commandcode.ai/alpha/whoami` → `GET /alpha/billing/credits` + `GET /alpha/usage/summary` — computes `used / total` from the billing period, prefers the 5-hour window limit when present.
- **OpenCode Go**: `GET https://opencode.ai/zen/go/v1/usage` — the API returns `rolling` / `weekly` / `monthly` percentages directly.

The status is set under the key `quota`, which sorts alphabetically just before `tokenSpeed` in pi's footer, placing it right next to the TPS display.

## License

MIT
