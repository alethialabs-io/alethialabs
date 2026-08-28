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

// TestT2ProviderTableTeardownBudgets pins the in-process destroy window for every cloud.
//
// A row that forgets the field gets the zero value, which makes context.WithTimeout return an
// ALREADY-EXPIRED context: the destroy would fail instantly, the cluster would leak to the workflow
// sweeper, and ResolveT2Budget would reserve nothing for it. That is silent in every other test, so
// it is asserted here rather than defaulted away in the resolver.
func TestT2ProviderTableTeardownBudgets(t *testing.T) {
	for name, p := range t2ProviderTable {
		if p.teardownTimeout <= 0 {
			t.Errorf("provider %q has no teardownTimeout: its t.Cleanup destroy would get an "+
				"already-expired context, and the go-timeout would reserve nothing for it", name)
		}
	}
	// The split is the whole point of #2729 — one number for both was hetzner's, charged to clouds
	// whose teardown is a different animal (an EKS internet gateway was still detaching at 13m30s).
	//
	// The managed number is 45m, not 30m, because 30m was MEASURED to be the worst possible length:
	// aws/floor run 33155063965 spent every second of it and was SIGINT'd with the internet gateway
	// at 19m50s and three subnets at 17m0s — all still inside the AWS provider's own 20m delete
	// ceiling, so the destroy was ~3m from an error that would have NAMED the dependency. See the
	// teardownTimeout field comment in t2_providers.go for the full breakdown of where the 30m went.
	want := map[string]time.Duration{
		"hetzner": 15 * time.Minute,
		"aws":     45 * time.Minute,
		"gcp":     45 * time.Minute,
		"azure":   45 * time.Minute,
		"alibaba": 45 * time.Minute,
	}
	for cloud, d := range want {
		p, ok := t2LookupProvider(cloud)
		if !ok {
			t.Errorf("no provider row for %q", cloud)
			continue
		}
		if got := resolveT2TeardownTimeout(p); got != d {
			t.Errorf("%s teardown = %s, want %s", cloud, got, d)
		}
	}
}

// TestT2TeardownOverride pins the escape hatch, including the fall-back an unparseable value takes —
// the same shape resolveT2WaitTimeout uses, so the two cannot behave differently under a typo.
func TestT2TeardownOverride(t *testing.T) {
	aws, ok := t2LookupProvider("aws")
	if !ok {
		t.Fatal("no aws provider row")
	}
	// The probe value must DIFFER from the row default, or "the override won" and "the override was
	// ignored" produce the same number and this test passes without testing anything. It used to be
	// 45m; the aws row is now 45m, so it moves rather than quietly going vacuous.
	if aws.teardownTimeout == 70*time.Minute {
		t.Fatal("the override probe value equals the aws row default — this test would be vacuous")
	}
	t.Setenv("ALETHIA_E2E_T2_TEARDOWN", "70m")
	if got := resolveT2TeardownTimeout(aws); got != 70*time.Minute {
		t.Errorf("override = %s, want 70m", got)
	}
	for _, bad := range []string{"seventy", "70", "", "  "} {
		t.Setenv("ALETHIA_E2E_T2_TEARDOWN", bad)
		if got := resolveT2TeardownTimeout(aws); got != aws.teardownTimeout {
			t.Errorf("override %q = %s, want the aws row default %s", bad, got, aws.teardownTimeout)
		}
	}
}

// TestT2BudgetReservesTeardownInGoTimeout is the anti-vacuity check for the teardown rung.
//
// TestT2BudgetLadderHolds cannot catch a dropped teardown reservation: removing the term only makes
// GoTimeout SMALLER, and ctx < go < step < job still holds. And TestT2BudgetCoversEveryEnabledScenario
// cannot catch it either, because teardown is deliberately excluded from Ctx — the test BODY must not
// get a longer wait just because the destroy is slow. So the reservation is asserted directly, and by
// varying the VALUE of the window rather than merely toggling a switch: a widened teardown must move
// the process deadline by exactly that much, and must leave the ctx alone.
func TestT2BudgetReservesTeardownInGoTimeout(t *testing.T) {
	for _, v := range T2BudgetScenarioEnv() {
		t.Setenv(v, "")
	}
	for _, cloud := range t2LadderClouds() {
		t.Run(cloud, func(t *testing.T) {
			p, ok := t2LookupProvider(cloud)
			if !ok {
				t.Fatalf("no provider row for %q", cloud)
			}
			def := p.teardownTimeout

			t.Setenv("ALETHIA_E2E_T2_TEARDOWN", "")
			base, err := ResolveT2Budget(cloud, "ladder")
			if err != nil {
				t.Fatalf("baseline: %v", err)
			}
			if want := base.Ctx + def + t2GoTimeoutMargin; base.GoTimeout < want {
				t.Errorf("go-timeout %s does not reserve the %s teardown window (ctx %s + teardown %s "+
					"+ margin %s = %s) — a destroy at its own ceiling would be killed mid-flight by the "+
					"test framework, losing the log naming what was still deleting",
					base.GoTimeout, def, base.Ctx, def, t2GoTimeoutMargin, want)
			}

			const wide = 60 * time.Minute
			t.Setenv("ALETHIA_E2E_T2_TEARDOWN", wide.String())
			got, err := ResolveT2Budget(cloud, "ladder")
			if err != nil {
				t.Fatalf("widened: %v", err)
			}
			if got.Ctx != base.Ctx {
				t.Errorf("widening teardown moved the ctx (%s → %s): teardown leaked into the test "+
					"body's budget, which would stretch every ctx-derived wait", base.Ctx, got.Ctx)
			}
			if delta, want := got.GoTimeout-base.GoTimeout, wide-def; delta != want {
				t.Errorf("widening teardown %s → %s moved the go-timeout by %s, want %s — the "+
					"reservation is not tracking the window the destroy is actually given",
					def, wide, delta, want)
			}
		})
	}
}
