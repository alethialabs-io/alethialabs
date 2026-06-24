#!/usr/bin/env python3
"""Alethia per-plan margin & unit-economics model (investor).
All COGS anchors are sourced from the repo; usage/CAC/churn are flagged [assumption].
Run: python3 margin_model.py  -> prints tables + writes unit-economics.csv
"""
import csv, io

# ============================================================
# ASSUMPTIONS (edit here). [SRC]=from repo/code, [A]=assumption to validate
# ============================================================
# Claude pricing $/MTok [SRC: claude-api skill, 2026-06]
PRICE = {"sonnet": {"in": 3.0, "out": 15.0}, "opus": {"in": 5.0, "out": 25.0}}
CACHE_READ_MULT = 0.10   # cache read ~0.1x input [SRC]

# AI credit actions [SRC: ai-credits.ts]
SCAN_CREDITS, MESSAGE_CREDITS = 20, 1
# tokens per action [A — biggest sensitivity; validate against telemetry]
MSG_TOK   = {"uncached_in": 600,   "cached_in": 8000, "out": 450}
SCAN_TOK  = {"uncached_in": 116000, "cached_in": 4000, "out": 2000}
CREDIT_SHARE_MSG = 0.70   # [A] share of consumed credits coming from messages vs scans

# Runner [SRC: usage.ts / spec17]
RUNNER_COST_PER_MIN = 0.00075      # our cost
RUNNER_OVERAGE_PRICE = 0.012       # we charge (94% margin) — expansion revenue, not COGS exposure
INCLUDED_MIN = {"community":200, "team":500, "business":5000, "enterprise":20000}  # [SRC: plan.ts]

# AI included WEEKLY credits [SRC: plan.ts]; *4.333 = monthly
WEEKLY_CREDITS = {"community":100, "team":3000, "business":15000, "enterprise":60000}
WEEKS_PER_MO = 4.333

# Platform/fixed COGS per customer by org-count scale [SRC: spec17]
PLATFORM_PER_CUST = {10:13.0, 50:3.40, 200:2.10, 1000:2.10}
SCALE = 50  # base case org count [A]

# Stripe fees [A]
STRIPE_PCT, STRIPE_FIXED = 0.029, 0.30
ENT_INVOICE_PCT = 0.010  # enterprise via annual invoice/ACH [A]

# Support per mo [A, anchored to spec17 ent ~$30]
SUPPORT = {"community":0, "team":0, "business":5, "enterprise":30}

# Prices [SRC: plan-catalog.ts]
TEAM_SEAT = 29.0
TEAM_FLAT_ALT = 299.0   # spec-17 alternative
BUSINESS = 999.0
ENTERPRISE = 2500.0

# Behavioral [A]
EXPECTED_AI_UTIL = 0.20   # avg user consumes 20% of included weekly allowance
WORST_AI_UTIL    = 1.00   # maxes it every week
BEST_AI_UTIL     = 0.05
EXPECTED_SEATS   = 5
EXPECTED_RUNNER_UTIL = {"community":0.5,"team":0.6,"business":0.6,"enterprise":0.5}  # frac of included min used

# CAC / churn [A — comparables-based]
CAC    = {"team":400, "business":2500, "enterprise":12000}
CHURN  = {"team":0.030, "business":0.020, "enterprise":0.010}  # monthly logo churn

# ============================================================
def eff_input_cost(uncached, cached, price_in):
    return (uncached*price_in + cached*price_in*CACHE_READ_MULT)/1e6
def action_cost(tok, model):
    p = PRICE[model]
    return eff_input_cost(tok["uncached_in"], tok["cached_in"], p["in"]) + tok["out"]*p["out"]/1e6

def cost_per_credit(model):
    msg_pc  = action_cost(MSG_TOK, model)/MESSAGE_CREDITS
    scan_pc = action_cost(SCAN_TOK, model)/SCAN_CREDITS
    return CREDIT_SHARE_MSG*msg_pc + (1-CREDIT_SHARE_MSG)*scan_pc, msg_pc, scan_pc

def ai_cogs(plan, util, model):
    monthly_credits = WEEKLY_CREDITS[plan]*WEEKS_PER_MO*util
    cpc,_,_ = cost_per_credit(model)
    return monthly_credits*cpc

def runner_cogs(plan, util):
    return INCLUDED_MIN[plan]*util*RUNNER_COST_PER_MIN

def stripe_fee(plan, revenue):
    if plan=="enterprise": return revenue*ENT_INVOICE_PCT
    return revenue*STRIPE_PCT + STRIPE_FIXED

def plan_econ(plan, revenue, ai_util, model, seats=1, runner_util=None, scale=SCALE):
    plat = PLATFORM_PER_CUST[scale]
    run  = runner_cogs(plan, runner_util if runner_util is not None else EXPECTED_RUNNER_UTIL[plan])
    ai   = ai_cogs(plan, ai_util, model)
    fee  = stripe_fee(plan, revenue)
    sup  = SUPPORT[plan]
    cogs = plat+run+ai+fee+sup
    gp   = revenue-cogs
    gm   = gp/revenue if revenue else 0
    return dict(revenue=revenue, platform=plat, runner=run, ai=ai, stripe=fee, support=sup,
                cogs=cogs, gp=gp, gm=gm)

def fmt(d): return {k:(round(v,2) if isinstance(v,float) else v) for k,v in d.items()}

# ---- credit COGS derivation ----
print("="*70); print("AI CREDIT COGS (per credit)"); print("="*70)
for m in ("sonnet","opus"):
    cpc,msg,scan = cost_per_credit(m)
    print(f"{m:7} blended ${cpc:.4f}/cr | message ${msg:.4f}/cr | scan ${scan*1:.4f}/cr "
          f"(scan total ${action_cost(SCAN_TOK,m):.3f}, msg total ${action_cost(MSG_TOK,m):.4f})")
print("We CHARGE on packs: $0.0180 (500), $0.0145 (2000), $0.0118 (5000) per credit")

# ---- per-plan scenarios ----
rows=[]
print("\n"+"="*70); print("PER-PLAN UNIT ECONOMICS"); print("="*70)
def show(label, plan, rev, util, model, seats=1, rutil=None, scale=SCALE):
    e=plan_econ(plan,rev,util,model,seats,rutil,scale)
    rows.append({"scenario":label,"plan":plan,"seats":seats,"model":model,"ai_util":util,
                 **{k:round(v,2) for k,v in e.items() if k!="gm"},"gm_pct":round(e["gm"]*100,1)})
    print(f"{label:34} rev ${e['revenue']:7.0f} | COGS ${e['cogs']:7.2f} "
          f"(plat {e['platform']:.1f} run {e['runner']:.2f} ai {e['ai']:.1f} stripe {e['stripe']:.1f} sup {e['support']:.0f}) "
          f"| GP ${e['gp']:8.2f} | GM {e['gm']*100:5.1f}%")

print("\n-- Free / Community (no revenue; COGS = funnel cost; AI+runner hard-capped) --")
fc = plan_econ("community", 0.0, EXPECTED_AI_UTIL, "sonnet")
print(f"{'Community (expected)':34} rev $      0 | cost-to-serve ${fc['cogs']:.2f}/mo (platform {fc['platform']} + ai {fc['ai']:.2f} + run {fc['runner']:.2f})")
worst_free = plan_econ("community",0.0,WORST_AI_UTIL,"opus");
print(f"{'Community (worst, capped)':34} rev $      0 | cost-to-serve ${worst_free['cogs']:.2f}/mo  (hard-stops; no overage)")

print("\n-- Team @ $29/seat --")
show("Team $29/seat x1 (expected)","team",TEAM_SEAT*1,EXPECTED_AI_UTIL,"sonnet",1)
show("Team $29/seat x5 (expected)","team",TEAM_SEAT*5,EXPECTED_AI_UTIL,"sonnet",5)
show("Team $29/seat x1 (WORST opus)","team",TEAM_SEAT*1,WORST_AI_UTIL,"opus",1)
show("Team $29/seat x5 (WORST opus)","team",TEAM_SEAT*5,WORST_AI_UTIL,"opus",5)
show("Team $29/seat x10 (best)","team",TEAM_SEAT*10,BEST_AI_UTIL,"sonnet",10)
print("\n-- Team @ $299 flat (spec-17 alt) --")
show("Team $299 flat (expected)","team",TEAM_FLAT_ALT,EXPECTED_AI_UTIL,"sonnet",1)
show("Team $299 flat (WORST opus)","team",TEAM_FLAT_ALT,WORST_AI_UTIL,"opus",1)

print("\n-- Business @ $999 --")
show("Business (expected)","business",BUSINESS,EXPECTED_AI_UTIL,"sonnet",1)
show("Business (WORST opus)","business",BUSINESS,WORST_AI_UTIL,"opus",1)
show("Business (best)","business",BUSINESS,BEST_AI_UTIL,"sonnet",1)

print("\n-- Enterprise @ $2,500 --")
show("Enterprise (expected)","enterprise",ENTERPRISE,EXPECTED_AI_UTIL,"sonnet",1,scale=200)
show("Enterprise (WORST opus)","enterprise",ENTERPRISE,WORST_AI_UTIL,"opus",1,scale=200)
show("Enterprise (best)","enterprise",ENTERPRISE,BEST_AI_UTIL,"sonnet",1,scale=200)

# ---- AI-allowance bound (the headline risk) ----
print("\n"+"="*70); print("AI INCLUDED-ALLOWANCE COST AS % OF PLAN REVENUE (full util)"); print("="*70)
for plan,rev in (("team",TEAM_SEAT),("team",TEAM_FLAT_ALT),("business",BUSINESS),("enterprise",ENTERPRISE)):
    for m in ("sonnet","opus"):
        a=ai_cogs(plan,1.0,m); print(f"{plan:10} rev ${rev:7.0f} {m:7} full-util AI COGS ${a:7.2f}  = {a/rev*100:5.1f}% of revenue")

# ---- Team seat sensitivity ----
print("\n"+"="*70); print("TEAM $29/seat — SEAT SENSITIVITY (expected AI util, sonnet)"); print("="*70)
for s in (1,3,5,10):
    e=plan_econ("team",TEAM_SEAT*s,EXPECTED_AI_UTIL,"sonnet",s)
    print(f"{s:2} seats  rev ${e['revenue']:6.0f} | COGS ${e['cogs']:6.2f} | GP ${e['gp']:7.2f} | GM {e['gm']*100:5.1f}%")

# ---- CAC / LTV / payback ----
print("\n"+"="*70); print("CAC / LTV / PAYBACK (expected-case GM)"); print("="*70)
seg_rev={"team":TEAM_SEAT*EXPECTED_SEATS,"business":BUSINESS,"enterprise":ENTERPRISE}
for seg in ("team","business","enterprise"):
    scale = 200 if seg=="enterprise" else SCALE
    e=plan_econ(seg,seg_rev[seg],EXPECTED_AI_UTIL,"sonnet",EXPECTED_SEATS if seg=="team" else 1,scale=scale)
    gp_mo=e["gp"]; ltv=gp_mo/CHURN[seg]; payback=CAC[seg]/gp_mo if gp_mo>0 else float('inf')
    print(f"{seg:10} GP/mo ${gp_mo:7.2f} | churn {CHURN[seg]*100:.1f}%/mo | LTV ${ltv:9.0f} | CAC ${CAC[seg]:6} | LTV/CAC {ltv/CAC[seg]:4.1f}x | payback {payback:4.1f} mo")

# ---- Blended P&L to $15k MRR (spec-16 mix) ----
print("\n"+"="*70); print("BLENDED P&L @ $15k MRR (spec-16 mix, expected util)"); print("="*70)
# mix: 2 enterprise @2500, 7 hosted (4 business@999 + 3 team@145), + ~$2k usage/AI (90% margin)
mix=[("enterprise",2,ENTERPRISE,1,200),("business",4,BUSINESS,1,SCALE),("team",3,TEAM_SEAT*EXPECTED_SEATS,EXPECTED_SEATS,SCALE)]
tot_rev=tot_cogs=0
for plan,n,rev,seats,scale in mix:
    e=plan_econ(plan,rev,EXPECTED_AI_UTIL,"sonnet",seats,scale=scale)
    tot_rev+=rev*n; tot_cogs+=e["cogs"]*n
    print(f"{n}x {plan:10} @${rev:6.0f}  subtotal rev ${rev*n:6.0f}  cogs ${e['cogs']*n:7.2f}")
usage_rev=2000; usage_cogs=usage_rev*0.12  # metered usage/AI packs ~88% margin
tot_rev+=usage_rev; tot_cogs+=usage_cogs
print(f"   usage/AI add-on   rev ${usage_rev}  cogs ${usage_cogs:.0f} (~88% margin)")
print(f"\nBLENDED MRR ${tot_rev:.0f} | COGS ${tot_cogs:.0f} | Gross profit ${tot_rev-tot_cogs:.0f} | Gross margin {(tot_rev-tot_cogs)/tot_rev*100:.1f}%")

# ---- write CSV ----
out="/private/tmp/claude-501/-Users-borislavborisov-work-Alethia/9d274db2-f1fe-425a-aba2-47de020e3b0a/scratchpad/unit-economics.csv"
with open(out,"w",newline="") as f:
    w=csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
print(f"\nwrote {out}")
