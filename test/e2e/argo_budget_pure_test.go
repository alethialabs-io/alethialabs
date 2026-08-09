// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The ArgoCD wait budget, pinned against the surface it is derived from (#2062).
//
// The flat 8m this replaced was chosen for the LEAN add-on tier and then inherited unchanged by
// the full 18-chart one. That is what killed the first real hetzner run of the 18-add-on set: the
// cluster was up, 7 nodes Ready, the receipt verified — and the assertion gave up with velero
// still `Missing`. A budget is only meaningful relative to the work it bounds, so these tests pin
// BOTH ends: it must grow with the surface, and it must stay under the parent that would cancel it.
//
// UNTAGGED: pure arithmetic over the provider table and the generated catalog fixture — no cloud,
// no cluster, no credentials.
package e2e

import (
	"testing"
	"time"
)

// The budget must never be shorter than the constant it replaced — no existing scenario gets
// tighter as a side effect of deriving it.
func TestArgoBudgetNeverBelowTheOldFlatDefault(t *testing.T) {
	for _, addOns := range []int{0, 1, 3, 5, 18, 40} {
		if got := argoBudgetFor(addOns); got < argoBudgetFloor {
			t.Errorf("argoBudgetFor(%d) = %s, below the %s floor", addOns, got, argoBudgetFloor)
		}
	}
}

// The lean tier must land on today's value. If this drifts, every lean run silently changed its
// timing characteristics for a change that was only ever about the full bar.
func TestArgoBudgetLeanTierIsUnchanged(t *testing.T) {
	if got := argoBudgetFor(0); got != 8*time.Minute {
		t.Errorf("lean budget = %s, want the historical 8m", got)
	}
}

// The full surface must buy materially more than the lean one, or the derivation is decoration.
// 8m was not enough for 18 charts — that is the measured fact this whole change rests on.
func TestArgoBudgetFullSurfaceExceedsWhatKilledTheHetznerRun(t *testing.T) {
	full := argoBudgetFor(expectedCatalogSize)
	if full <= 8*time.Minute {
		t.Fatalf("full-surface budget = %s, still <= the 8m that failed with velero Missing", full)
	}
	if lean := argoBudgetFor(0); full <= lean {
		t.Errorf("full-surface budget %s does not exceed the lean budget %s", full, lean)
	}
}

// The budget must stay under the SMALLEST parent bound in t2_providers.go. Budgeting past the
// timeout that cancels you buys nothing: the run dies at the parent instead, with a worse message.
// Derived from the real table so a provider whose waitTimeout is lowered reds this test rather
// than silently making the Argo budget unreachable.
func TestArgoBudgetStaysUnderEveryProviderWaitTimeout(t *testing.T) {
	if len(t2ProviderTable) == 0 {
		t.Fatal("t2ProviderTable is empty — this test would be vacuous")
	}
	for name, p := range t2ProviderTable {
		if p.waitTimeout <= 0 {
			t.Errorf("provider %q has no waitTimeout", name)
			continue
		}
		if argoBudgetCeiling >= p.waitTimeout {
			t.Errorf("argoBudgetCeiling %s >= provider %q waitTimeout %s — the Argo wait can outlive the job wait that cancels it",
				argoBudgetCeiling, name, p.waitTimeout)
		}
	}
}

// The ceiling has to actually bind, or a catalog that grows unnoticed walks the budget past the
// parent bound the test above pins.
func TestArgoBudgetCeilingBinds(t *testing.T) {
	if got := argoBudgetFor(1000); got != argoBudgetCeiling {
		t.Errorf("argoBudgetFor(1000) = %s, want the %s ceiling", got, argoBudgetCeiling)
	}
}

// The env override remains the explicit escape hatch and must win over the derivation.
func TestArgoAssertTimeoutEnvOverrideWins(t *testing.T) {
	t.Setenv("ALETHIA_E2E_ARGO_TIMEOUT", "3m")
	if got := ArgoAssertTimeout(); got != 3*time.Minute {
		t.Errorf("ArgoAssertTimeout() = %s, want the 3m override", got)
	}
}

// An unparseable override must fall back to the derivation, not to zero — a zero budget would fail
// every assertion instantly and read as a broken cluster.
func TestArgoAssertTimeoutIgnoresAnUnparseableOverride(t *testing.T) {
	t.Setenv("ALETHIA_E2E_ARGO_TIMEOUT", "not-a-duration")
	if got := ArgoAssertTimeout(); got < argoBudgetFloor {
		t.Errorf("ArgoAssertTimeout() = %s on a bad override, want at least the %s floor", got, argoBudgetFloor)
	}
}

// The full-surface path must read the real catalog and agree with the fixture's own size guard.
// A fixture that shrank would otherwise quietly shorten the budget for a run that still installs
// everything — the vacuity class AllCatalogAddOns already fails closed on.
func TestArgoAddOnCountMatchesTheCatalogWhenFullSurfaceIsOn(t *testing.T) {
	t.Setenv("ALETHIA_E2E_ALL_ADDONS", "1")
	got := argoAddOnCount()
	if got < expectedCatalogSize {
		t.Errorf("argoAddOnCount() = %d with the full surface on, want at least %d", got, expectedCatalogSize)
	}
}

// …and the lean tier must not pay for charts it never seeds.
func TestArgoAddOnCountIsZeroOnTheLeanTier(t *testing.T) {
	t.Setenv("ALETHIA_E2E_ALL_ADDONS", "")
	if got := argoAddOnCount(); got != 0 {
		t.Errorf("argoAddOnCount() = %d on the lean tier, want 0", got)
	}
}
