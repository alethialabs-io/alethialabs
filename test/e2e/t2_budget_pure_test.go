// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// FREE, every-PR proof of the T2 timeout LADDER — no build tag, no cloud.
//
// The workflow used to carry the ladder as prose and four hard-coded numbers, and the prose was
// wrong in two independent ways at once (a hetzner ctx quoted for every cloud; a go-timeout larger
// than the step cap that contained it). Prose cannot be tested. This can: it walks the FULL POWERSET
// of scenario switches across every cloud and asserts ctx < go < step < job every time, so no
// scenario combination — including ones nobody has run yet — can produce a ladder where the wrong
// rung fires first.
package e2e

import (
	"os"
	"testing"
	"time"
)

// t2LadderClouds is every cloud with a provider row, so a newly added cloud is covered for free.
func t2LadderClouds() []string {
	out := make([]string, 0, len(t2ProviderTable))
	for name := range t2ProviderTable {
		out = append(out, name)
	}
	return out
}

func TestT2BudgetLadderHolds(t *testing.T) {
	scenarios := T2BudgetScenarioEnv()
	if len(scenarios) == 0 {
		t.Fatal("no scenario switches enumerated — the powerset would be a single case and prove nothing")
	}
	// Clear everything first: the ambient environment must not decide what this test covers.
	// (Agent tests inheriting laptop state is its own recurring bug class.)
	for _, v := range scenarios {
		t.Setenv(v, "")
	}
	t.Setenv("ALETHIA_E2E_ARGO_TIMEOUT", "")

	var worst T2Budget
	combos := 1 << len(scenarios)
	for _, cloud := range t2LadderClouds() {
		for mask := 0; mask < combos; mask++ {
			for i, v := range scenarios {
				if mask&(1<<i) != 0 {
					// "1" is truthy for every switch, and a valid duration for the soak.
					if v == "ALETHIA_E2E_SOAK" {
						t.Setenv(v, "10m")
					} else {
						t.Setenv(v, "1")
					}
				} else {
					t.Setenv(v, "")
				}
			}
			b, err := ResolveT2Budget(cloud, "ladder")
			if err != nil {
				t.Fatalf("%s mask=%d: ResolveT2Budget: %v", cloud, mask, err)
			}
			if b.Ctx <= 0 {
				t.Fatalf("%s mask=%d: ctx must be positive, got %s", cloud, mask, b.Ctx)
			}
			// THE INVARIANT. Strict, in order, no ties: a tie means both could fire and which one
			// wins is a race, which is exactly as useless as the wrong one winning.
			if !(b.Ctx < b.GoTimeout && b.GoTimeout < b.Step && b.Step < b.Job) {
				t.Errorf("%s mask=%d: ladder violated — need ctx < go < step < job, got %s\n%s",
					cloud, mask, b.Describe(), "each rung must strictly contain the one below it")
			}
			// The workflow expresses go/step/job in whole minutes, so a fractional value would be
			// truncated by YAML and could invert the ordering the assertion above just approved.
			for _, r := range []struct {
				name string
				d    time.Duration
			}{{"go-timeout", b.GoTimeout}, {"step", b.Step}, {"job", b.Job}} {
				if b.Ctx > 0 && r.d%time.Minute != 0 {
					t.Errorf("%s mask=%d: %s must be a whole number of minutes, got %s", cloud, mask, r.name, r.d)
				}
			}
			if b.Job > worst.Job {
				worst = b
			}
		}
	}
	t.Logf("widest ladder across %d clouds x %d scenario combinations: %s",
		len(t2LadderClouds()), combos, worst.Describe())
}

// TestT2BudgetCoversEveryEnabledScenario is the anti-vacuity check: turning a switch ON must make
// the ctx GROW. Without it, a scenario whose term was silently dropped from ResolveT2Budget would
// still satisfy the ladder test above — the ladder would just be built on a ctx that under-counts,
// which is the original bug wearing a passing test as a disguise.
func TestT2BudgetCoversEveryEnabledScenario(t *testing.T) {
	scenarios := T2BudgetScenarioEnv()
	for _, v := range scenarios {
		t.Setenv(v, "")
	}
	base, err := ResolveT2Budget("aws", "ladder")
	if err != nil {
		t.Fatalf("baseline: %v", err)
	}
	for _, v := range scenarios {
		t.Run(v, func(t *testing.T) {
			for _, other := range scenarios {
				t.Setenv(other, "")
			}
			if v == "ALETHIA_E2E_SOAK" {
				t.Setenv(v, "10m")
			} else {
				t.Setenv(v, "1")
			}
			b, err := ResolveT2Budget("aws", "ladder")
			if err != nil {
				t.Fatalf("with %s on: %v", v, err)
			}
			if b.Ctx <= base.Ctx {
				t.Errorf("enabling %s did not widen the ctx (%s with it on vs %s baseline) — its term is "+
					"missing from ResolveT2Budget, so the run would be bounded as if the scenario were off",
					v, b.Ctx, base.Ctx)
			}
		})
	}
}

// TestSoakAcceptsAnExplicitDisable pins the sentinels. The workflow resolves
// `vars.E2E_SOAK || '10m'`, so an unset repo variable arrives as "10m" — there was no way to turn
// the soak off from a variable at all: "0" hit the non-positive error and only a literal single
// space worked, which nothing documented.
func TestSoakAcceptsAnExplicitDisable(t *testing.T) {
	for _, raw := range []string{"off", "OFF", "none", "None", "0", " off "} {
		if d, on, err := parseSoakDuration(raw); err != nil || on || d != 0 {
			t.Errorf("parseSoakDuration(%q) = (%s, %v, %v); want a clean disable", raw, d, on, err)
		}
	}
	// Typos must STILL be loud — that is the reason the non-positive check exists.
	for _, raw := range []string{"0s", "0m", "0ms", "10 m", "ten minutes", "-5m"} {
		if _, on, err := parseSoakDuration(raw); err == nil || on {
			t.Errorf("parseSoakDuration(%q) must stay a loud error (on=%v err=%v)", raw, on, err)
		}
	}
	// And a real window still parses.
	if d, on, err := parseSoakDuration("12m"); err != nil || !on || d != 12*time.Minute {
		t.Errorf(`parseSoakDuration("12m") = (%s, %v, %v)`, d, on, err)
	}
}

// TestSoakOffFreesItsBudget ties the sentinel to the thing it exists for: the ctx must actually
// shrink, so a leg that needs its 25m back (the fabric demo is already the widest term) can have it.
func TestSoakOffFreesItsBudget(t *testing.T) {
	for _, v := range T2BudgetScenarioEnv() {
		t.Setenv(v, "")
	}
	t.Setenv("ALETHIA_E2E_SOAK", "10m")
	on, err := ResolveT2Budget("gcp", "ladder")
	if err != nil {
		t.Fatalf("soak on: %v", err)
	}
	t.Setenv("ALETHIA_E2E_SOAK", "off")
	off, err := ResolveT2Budget("gcp", "ladder")
	if err != nil {
		t.Fatalf("soak off: %v", err)
	}
	if want := 25 * time.Minute; on.Ctx-off.Ctx != want {
		t.Errorf("ALETHIA_E2E_SOAK=off freed %s, want %s (the 10m window + %s headroom)",
			on.Ctx-off.Ctx, want, t2SoakHeadroom)
	}
}

// TestT2BudgetRejectsAnUnknownCloud keeps the failure mode honest: a typo'd provider must not
// silently resolve to a zero budget, which would produce a ladder of pure margins.
func TestT2BudgetRejectsAnUnknownCloud(t *testing.T) {
	if _, err := ResolveT2Budget("nimbus", "ladder"); err == nil {
		t.Fatal("an unknown cloud must be an error, not a zero budget")
	}
}

// TestT2BudgetPropagatesASoakParseError proves the loud-before-spend property survived the move out
// of t2_provision_test.go: the parse error used to fail the test directly, and now has to travel.
func TestT2BudgetPropagatesASoakParseError(t *testing.T) {
	for _, v := range T2BudgetScenarioEnv() {
		t.Setenv(v, "")
	}
	t.Setenv("ALETHIA_E2E_SOAK", "10 m")
	if _, err := ResolveT2Budget("aws", "ladder"); err == nil {
		t.Fatal("a malformed ALETHIA_E2E_SOAK must fail budget resolution, before any provisioning spend")
	}
	if os.Getenv("ALETHIA_E2E_SOAK") != "10 m" {
		t.Fatal("test env not applied")
	}
}
