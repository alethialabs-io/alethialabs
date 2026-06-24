# 27 — Unit economics & per-plan margins (investor model)

**Purpose.** Defensible per-plan gross margins, worst-case and expected scenarios, and blended unit economics for the investor deck. Resolves the Team-price discrepancy (`14`/`17` say ~$299; the shipped app `plan-catalog.ts` says $29/seat) with numbers.

**Status.** First pass. Infrastructure COGS is grounded in code/specs; **AI-credit cost and usage/CAC/churn are explicit assumptions** (tagged `[A]`) pending live instrumentation (see §8 — Admin/FinOps panel). Reproduce with `27-unit-economics.calc.py` → `27-unit-economics.csv`.

## 1. Sources & assumptions

**Grounded (code/specs):**
- Prices — Team `$29/seat/mo`, Business `$999/mo`, Enterprise `from $2,500/mo` (`plan-catalog.ts`); `$299` flat alt (`17`).
- Included runner-minutes/mo — 200 / 500 / 5,000 / 20,000 (`plan.ts`); runner cost **$0.00075/min**, overage **$0.012/min** (~94%) (`usage.ts`, `17`).
- AI — scan = 20 credits, message = 1 credit; packs 500/$9, 2,000/$29, 5,000/$59 (charge $0.0118–0.0180/credit); included **weekly** credits 100 / 3,000 / 15,000 / 60,000 (`ai-credits.ts`, `plan.ts`). Default model **Sonnet 4.6** (`config/ai.ts`).
- Claude pricing — Sonnet 4.6 **$3/$15** per MTok, Opus 4.8 **$5/$25**; cache read ~0.1× input (claude-api, 2026-06).
- Platform COGS/customer — ~$13 @10 orgs, **~$3.40 @50**, ~$2.10 @200+ (`17`).

**Assumptions `[A]` (validate with telemetry):** AI cost/credit derived from tokens-per-action (msg ~600 in/450 out cached; scan ~120k tok) → **~$0.013/credit Sonnet, ~$0.022/credit Opus blended**; expected AI utilization **20%** of the included weekly allowance (worst 100%, best 5%); avg Team **5 seats**; Stripe 2.9%+$0.30 (Enterprise invoice ~1%); support Enterprise ~$30/mo; CAC Team/Biz/Ent $400/$2,500/$12,000; monthly logo churn 3%/2%/1%.

> ⚠️ The AI cost/credit is the single biggest swing (blended GM ~76% → ~95%+). Our modeled cost/credit ($0.0134 Sonnet) currently sits *above* the $0.0118 large-pack price — a tell that the token assumption is likely ~2× high, **or** packs are thin. Only live usage data settles this (§8).

## 2. Per-plan unit economics (monthly)

| Plan (scenario) | Revenue | COGS | of which AI | Gross profit | GM% |
|---|--:|--:|--:|--:|--:|
| Community / Free (expected) | $0 | $4.93 cost-to-serve | $1.16 | — | funnel |
| **Team $29/seat ×1** (expected) | $29 | $39 | $35 | **−$10** | **−36%** |
| **Team $29/seat ×5** (expected) | $145 | $43 | $35 | $102 | **70%** |
| Team $299 flat (expected) | $299 | $47 | $35 | $252 | 84% |
| **Business $999** (expected) | $999 | $214 | $174 | $786 | **79%** |
| **Enterprise $2,500** (expected) | $2,500 | $759 | $694 | $1,741 | **70%** |

Worst case (full AI utilization on Opus) goes negative on every paid tier — see §4. Infra-only (ex-AI) margin is **~99%** on every tier, matching `17`.

## 3. The Team-price resolution (DECISION)

Single-seat Team at $29 is **margin-negative even at the expected case**; it clears at ~2–3 seats:

| Team seats @ $29 | Revenue | GM% (expected) |
|--:|--:|--:|
| 1 | $29 | −36% |
| 3 | $87 | 53% |
| 5 | $145 | 70% |
| 10 | $290 | 84% |

**Decision: keep the shipped $29/seat, add a per-org minimum (3 seats / ~$87 floor).** Matches the live app, removes the only structurally-negative corner, and avoids re-pricing. (Spec-17's $299 flat also works at ~84% but diverges from what's shipped.)

## 4. AI is the entire margin risk (headline)

Infrastructure is ~99% margin and runner-minutes are negligible ($0.15–$15/mo of included cost). **All variable-cost risk is the AI allowance.** Included-allowance cost as a % of plan revenue at **full utilization**:

| Plan | Sonnet | Opus |
|---|--:|--:|
| Team $29 | 599% | 998% |
| Team $299 | 58% | 97% |
| Business $999 | 87% | 145% |
| Enterprise $2,500 | 139% | 231% |

Mitigants already in place / recommended: **Sonnet default** (Opus is opt-in), credits **hard-stop** (no involuntary overage — worst-case to us is bounded by the included allowance), realistic utilization is low, and overage is **billed** (packs = expansion revenue). **Recommended guardrails:** size included weekly credits against Sonnet cost; consider gating Opus on Team; treat the included allowance as a Sonnet-costed budget.

## 5. CAC / LTV / payback (expected GM, `[A]` CAC & churn)

| Segment | GP/mo | Churn | LTV | CAC | LTV/CAC | Payback |
|---|--:|--:|--:|--:|--:|--:|
| Team (5 seats) | $102 | 3.0% | $3,405 | $400 | 8.5× | 3.9 mo |
| Business | $786 | 2.0% | $39,275 | $2,500 | 15.7× | 3.2 mo |
| Enterprise | $1,741 | 1.0% | $174,110 | $12,000 | 14.5× | 6.9 mo |

All segments clear the 3× LTV/CAC and <12-mo payback bars.

## 6. Blended P&L (path to the `16` target)

Spec-16 mix (2 Enterprise + 4 Business + 3 Team×5 seats + ~$2k usage/AI), expected utilization:
**MRR ~$11.4k · COGS ~$2.7k · gross profit ~$8.7k · gross margin ~76%.** (Reaching the full $15k MRR needs ~2 more Business-equivalents; margin holds.) Ex-AI, blended GM is ~95%+. The spread between 76% and 95% is exactly the AI-allowance assumption — which §8 makes a measured number, not a guess.

## 7. Sensitivity

The model's swing factors, in order: **AI cost/credit** (token assumptions + Sonnet vs Opus), **AI utilization**, **Team seats**, then (minor) hosting (AWS vs Hetzner — <$1/cust at scale) and Stripe fees. `27-unit-economics.calc.py` parameterizes all of them.

## 8. Recommendation — instrument real margins (Admin / FinOps panel)

The static model can't pin AI margin; **the live DB can.** Build an internal admin panel that computes **actual** margin per org/plan in real time from existing data:
- **Inputs we already store:** `runner_usage_sessions` (managed runner-minutes), AI credits consumed per org × action × model, plan/seats/billing — multiplied by **current** model token prices and infra unit costs.
- **Output:** real cost-to-serve and gross margin per org, per plan, and blended; flags orgs whose AI/runner consumption approaches or exceeds their plan economics (the negative corners this model only estimates).
- **Growth signal:** track the **self-host funnel** — GitHub stars / forks / clones (traffic API) and any opt-in self-host telemetry — alongside hosted conversion, to see open-core → paid pull.

This turns pricing from guesswork into a dashboard, lets us tune included allowances against real cost, and gives investors *actual* margins. Proposed as the next build (own design doc/plan).

## Out of scope
- No product/billing code changes here (analysis only). The admin panel in §8 is a separate initiative.
- AI cost/credit and CAC/churn remain `[A]` until §8 lands real data.
