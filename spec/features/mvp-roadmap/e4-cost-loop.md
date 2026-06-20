# E4 — Cost estimation: close the loop

**Goal:** the cost the console shows is the **real** Infracost number, live in the designer and on
plan results. Community/core.

## Problem (grounded)
Infracost actually runs in the runner at plan time (`packages/core/infracost/infracost.go` →
`cost_breakdown` returned in job `execution_metadata`), but the console's `specs.estimated_monthly_cost`
+ cost display look **disconnected** from it, and `app/server/actions/pricing.ts` (`getRegionPrices`)
is an unused AWS-pricing stub.

## Tasks
- [ ] Persist the runner's plan-time `cost_breakdown` to the spec/job and render it in the designer's
      cost sidebar + the plan-result view (replace the static `estimated_monthly_cost` display path).
- [ ] Retire or repurpose the `getRegionPrices` stub.
- [ ] Bake the `infracost` binary into the runner image (currently downloaded per-plan — see the
      hardcoded `v0.10.39` in `provisioner/deploy.go`).
- [ ] (Optional) a fast client-side estimate as the user designs, reconciled by the real plan number.

## Done when
Designing a spec shows a live estimate; running a plan replaces it with the real Infracost breakdown;
no per-plan binary download.
