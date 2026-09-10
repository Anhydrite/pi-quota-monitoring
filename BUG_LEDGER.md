# Bug Ledger

Institutional memory of user-reported bugs and fabrication defects. Every entry
starts as 🔴 OPEN and becomes ✅ FIXED (with root cause and evidence) once its
guard test passes.

| # | Date | Reporter | Symptom | Guard test | Status |
|---|------|----------|---------|------------|--------|
| 1 | 2026-09-10 | Haryon (pi user) | With `quotaCost.enabled = true` the footer showed `req ↑$0.220/M ↓$0.660/M R$0.007/M` for `deepseek/deepseek-v4-flash` **inside the documented peak window** (06:00–10:00 UTC, Mon–Fri) — a locally stored rate presented as the bill, 2× understated at peak. The provider API exposes no prices at all, so every displayed figure was invented | provider: `tests/test-no-static-pricing.ts`, `tests/test-real-cost.ts`; extension: `tests/request-cost.test.ts` | ✅ FIXED (working trees, not committed) — no static rate card anywhere; the gateway bill is the only cost source |
| 2 | 2026-09-10 | Agent (from #1) | The readout additionally attributed a **per-component** rate split (`↑` fresh input, `R` cache reads) that the gateway never reports: it bills one input-side amount. Live capture: the gateway billed `144 fresh @ $0.30/M + 1024 cache reads @ $0.006/M = 4.9344e-05`, while the readout displayed `↑$0.343/M` and a free `R` | extension: `tests/request-cost.test.ts`; provider: `tests/test-stream.ts` | ✅ FIXED (working trees, not committed) — billed amounts + request-wide effective rate only |
| 3 | 2026-09-10 | Agent (during #1) | `tests/test-pi-local.mjs` (real-`pi` e2e suite of `pi-commandcode-provider`) aborted with `AssertionError: 404 Not found` on the "Claude request through Anthropic Messages endpoint" case, silently skipping its last five cases. **Pre-existing**, not caused by the fix: reproduced on pristine `HEAD` in an isolated worktree | `tests/test-pi-local.mjs` | ✅ FIXED (working tree, not committed) — mock routes on the pathname; suite reaches `PASS` |
| 4 | 2026-09-10 | Haryon (pi user) | The readout was unusable: `req ↑$7.00/M ↓$1.20/M · real ↑$0.999/M ↓$0.171/M` for a request of 242 fresh / 270 080 cache tokens. The `↑` rate divided the *whole* input-side amount by the fresh tokens only (so it tracked the cache ratio, not a price: here $6.996/M where the real billed rate is $0.30/M), and `real` divided that by a plan multiplier taken from a hard-coded plan-price table | extension: `tests/rate-ledger.test.ts`, `tests/request-cost.test.ts` | ✅ FIXED (working trees, not committed) — rates recovered from the gateway invoices, multiplier = API allowance ÷ user-declared price |
| 5 | 2026-09-10 | Haryon (pi user) | The cost readout disappeared entirely on a terminal narrower than 77 columns instead of being shortened | extension: `tests/rate-ledger.test.ts` (degradation ladder) | ✅ FIXED (working trees, not committed) — richest-fit form, own line when needed |
| 6 | 2026-09-10 | Agent | A earlier claim in this ledger (peak is not a fixed x2) was wrong: it compared two different billed rate lists. The session was in fact billed under three lists, and within one list peak is exactly x2 | `tests/rate-ledger.test.ts` (window separation) | ✅ CORRECTED — grouping by billed rate is required for correctness |

## Details

### #1 — the readout displayed a locally stored rate as if it were the bill

- **Reported**: 2026-09-10, session `01a08a77` (`commandcode` /
  `deepseek/deepseek-v4-flash`), request at `2026-09-10T08:38:28.579Z` —
  inside the 06:00–10:00 UTC weekday peak window. "je vois 0.220/M pour deepseek
  alors qu'on est en peak hours" / "quotaCost est à true donc je suis censé avoir
  les quotas réels".
- **Documented pricing** (`https://commandcode.ai/docs/resources/pricing-limits`,
  fetched 2026-09-10): DeepSeek V4 Pro / Flash / Flash Vision (exp) are
  time-dependent — peak `01:00–04:00` and `06:00–10:00` UTC, Monday–Friday
  (7h/day), at **2× the off-peak price, cache reads included**; weekends are
  off-peak all day. The pricing table headlines the off-peak rate (17h/day).
- **Root cause**: `src/pricing.ts` stored one flat off-peak rate per model and
  `src/cost.ts` applied it unconditionally, so every consumer (pi's footer `$`,
  `/commandcode-quota`, this readout) presented a stored estimate as the bill.
  Compounding it, the accurate path — the gateway's `provider-metadata` bill via
  `/alpha/generate` — was opt-in and therefore off in the user's configuration.
- **Why a local table can never be right**: the model catalog
  (`GET /provider/v1/models`) returns ids, names, and context windows only —
  **zero price fields** (probed live). Any rate shown had to be invented locally,
  and the DeepSeek row was additionally stale (it carried the
  `V4 Flash Vision (exp)` rates at the time the gateway billed the
  `V4 Flash (latest)` peak rate).
- **Fix**: no static rate card anywhere.
  - Removed `src/pricing.ts`, `src/cost.ts`, their fixtures, their suites, and
    the skill step that refreshed them. Models are declared at zero cost and
    `usage.cost` stays zero until the gateway reports an amount.
  - Real billed cost is the default (`src/real-cost.ts`), so requests route
    through `/alpha/generate` and `usage.cost` receives the gateway's figures.
    Opting out (`/commandcode-realcost off`, or `COMMANDCODE_REAL_COST=0`) shows
    **no cost** rather than a guess.
- **Verification**:
  - `npm test` in `pi-commandcode-provider`: exit 0, **241/241**, `pi-local` e2e
    `PASS` (its new case asserts exactly one `POST /alpha/generate`, zero
    Provider API requests, correct model, bearer header).
  - `npm test` in `pi-quota-monitoring`: exit 0, **14/14** (new suite).
  - Live probe at **09:17 UTC** (inside the peak window): default run recorded
    `total=$0.0000517440` with `total == input + output` exactly and an output
    rate of exactly `$1.20/M` (the published peak rate); the opt-out run recorded
    `0` everywhere.
  - Footer harness driving the real extension code with a fake host:
    `message_end` → `req $0.000052 · in/out $0.000049/$0.000002 · eff $0.044/M · total $0.000052`,
    rendered on the third footer line with no per-component rate and no plan
    value.
- **Superseded decisions**: the local peak-window table (option A), the
  extension-only patch (option C), refreshing the stale DeepSeek row (option F)
  and an "estimated" marker (option E) all became moot once no local rate exists.

### #2 — a per-component rate split the gateway never reports

- **Symptom**: for a request the gateway billed as one input-side amount of
  `4.9344e-05`, the readout showed `↑$0.343/M` and cache reads as free.
- **Evidence**: the captured amount decomposes exactly as
  `144 fresh @ $0.30/M + 1024 cache reads @ $0.006/M` (peak rates) — so the
  gateway does charge for cache reads. Attributing the whole input-side amount to
  fresh tokens overstated `↑` and drove `R` to zero.
- **Root cause**: the split was reconstructed from the model catalog rates that
  #1 removed. With an all-zero catalog the code fell through to "bill everything
  on fresh tokens", and the window-multiplier derivation (plus its fallbacks)
  became unreachable.
- **Fix**: the provider stores the gateway's amounts verbatim — `cost.input` is
  the whole input side, `cost.output` the output side, and the cache components
  stay `0`, documented as *not reported* rather than *free* (a reader must not
  interpret those zeros as a price). The readout shows the billed amounts plus a
  request-wide effective `$/M`, and attributes nothing per component.

### #3 — the pi-local e2e suite was red before any of this work

- **Symptom**: `node tests/test-pi-local.mjs` aborted at
  `assert.equal(claudePrint.code, 0, claudePrint.stderr)` with
  `AssertionError: 404 Not found`. Everything after it (RPC commands, image
  input, compat registry, overflow recovery) never ran, so those cases had been
  silently unreported.
- **Evidence**: `git worktree add /tmp/cc-head HEAD` (symlinked `node_modules`)
  reproduced the identical failure on pristine `HEAD`. An instrumented mock that
  logs every request showed the rejected request is
  `POST /provider/v1/messages?beta=true`, while the mock matched
  `req.url === "/provider/v1/messages"` exactly. Source of the query flag: pi's
  bundled Anthropic SDK does
  `this._client.post("/v1/messages?beta=true", …)`
  (`pi-coding-agent/dist/bundle/chunks/chunk-CLNPYIDP.js`) — nothing the
  extension controls. The opt-out run fails identically, which proves the
  cost change is not the cause.
- **Fix**: route the mock on the parsed `pathname`. The suite also pins
  `COMMANDCODE_REAL_COST=0` in its base env (it asserts Provider API request
  shapes) and adds a case proving the new default end to end.

### #4 — the displayed rates measured the cache ratio, not a price

- **Symptom** (reported): `req ↑$7.00/M ↓$1.20/M · real ↑$0.999/M ↓$0.171/M` for a
  request billed `$0.00169308` on the input side and `$0.002004` on the output side,
  with 242 fresh / 270 080 cache / 1 670 output tokens.
- **Root cause**: `↑` was `inputCost ÷ freshTokens`. The gateway bills ONE input-side
  amount covering fresh **and** cache tokens, so dividing it by the fresh tokens alone
  made the figure a function of the cache ratio — not a rate. Here: `$6.996/M` against
  a real billed fresh rate of `$0.30/M` (~23x overstated); the true blended rate is
  `$0.00626/M`. `real` additionally divided by a plan multiplier read from a hard-coded
  plan-price table, mixing a fact with an invention. `↓$1.20/M` happened to be correct
  because output is billed at a single per-token rate.
- **Fix**: recover the rates from the invoices instead of computing them from the
  displayed amounts.
  - `extensions/rate-ledger.ts`: output rate is `outputCost ÷ outputTokens` (exact from
    a single request); the two input rates solve `inputCost = fresh × rFresh + cache × rCache`
    by least squares over requests, using `cost.input + cost.cacheRead` so older
    attributed records and current whole-input records feed the same equation.
  - Requests are grouped by the **billed** output rate, so a price-window change is
    detected from the data (`windowCount` observations: 293 off-peak requests →
    `$0.22 / $0.007 / $0.66`, then 54 peak requests → `$0.30 / $0.006 / $1.20`). No
    calendar and no rate table is embedded.
  - `réel` = billed ÷ (API allowance ÷ user-declared plan price); the allowance is read
    from `/alpha/billing/credits` + `/alpha/usage/summary`, the price is declared with
    `/quota-cost plan <usd>` because no API exposes it. Missing either → the `réel` part
    is omitted rather than assumed.
- **Verification**: replaying the user's real session (347 billed requests) through the
  production modules yields the readout on 345 of them, with exactly two transitions:
  `↑$0.220/M ↓$0.660/M · réel ↑$0.031/M ↓$0.094/M` after 2 requests, then
  `↑$0.300/M ↓$1.20/M · réel ↑$0.043/M ↓$0.171/M` after 295. `npm test`: 21/21.
- **Note**: the peak/off-peak ratio is model-specific, not a fixed ×2 (×1.36 input,
  ×1.82 output here) — which is exactly why the rates must come from the bills.

### #5 — the readout vanished on a narrow terminal

- **Symptom**: measured on the real footer, the cost readout disappeared entirely
  below 77 columns (it was dropped rather than shortened).
- **Root cause**: `composeStatusLine` kept only the quota statuses when the cost
  segment did not fit, by design ("hide when there is no room").
- **Fix**: the readout is built as a richest-first ladder of forms
  (`req … R… · réel …` → `req … R…` → `↑… ↓… R…` → `↓… R…` → `↓…`), and the first
  form that can be shown wins — either to the right of the statuses or on its own
  line, since a richer fact on a dedicated line beats a poorer one crammed next to
  the quotas. Verified in the real footer: 160/110/90 columns share the status line,
  70/55/40 give the readout its own line, 28 columns shows `↓$0.600/M R$0.003/M`, and
  18 columns still keeps `↓$0.600/M`.
- **Also in this change**: the cache-read rate is now displayed (`R$…/M`); it was
  recovered by the ledger but never rendered. Identifiability was checked before
  showing it: 2346 exact pairs from the user's own bills all yield `$0.3000/$0.00600`
  with zero spread, and the least-squares fit reproduces every invoice to 0.000%
  relative error.

### #6 — correction: peak is an exact x2, but only within one rate list

- Earlier analysis in this ledger claimed the peak/off-peak switch was "not a fixed
  multiplier" (x1.36 input, x1.82 output). **That was wrong**: it compared the peak
  group against a group billed under a *different, older* rate list.
- The user's session was billed under three lists in one day:
  `$0.22/$0.66/$0.007` (293 req), `$0.30/$1.20/$0.006` peak (84 req), and
  `$0.15/$0.60/$0.003` current off-peak (9 req). Within one list the peak ratio is
  exactly x2 on all three rates (`0.15→0.30`, `0.60→1.20`, `0.003→0.006`).
- **Consequence for the design**: grouping by the *billed* output rate is not a
  convenience, it is required for correctness — a x2 rule applied to a stale base
  would produce a wrong figure. This is why no rate table and no window calendar is
  embedded.

## Verification commands

```sh
# provider (241 tests + real-pi e2e)
cd ~/.pi/agent/git/github.com/Anhydrite/pi-commandcode-provider && npm test

# extension (14 tests: facts-only readout)
cd ~/Documents/beta_labo/pi-quota-monitoring && npm test

# live: default vs opt-out, asserting the recorded amounts are the gateway's
bash /tmp/probe-factual-cost.sh
```
