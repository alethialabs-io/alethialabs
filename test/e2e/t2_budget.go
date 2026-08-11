// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

import (
	"fmt"
	"math"
	"os"
	"sort"
	"strings"
	"time"
)

// The T2 timeout LADDER, in one place, derived rather than restated.
//
// e2e-nightly.yml used to hard-code four numbers (ctx-implied 40m, `go test -timeout` 80m, step 75m,
// job 90m) beside a comment asserting "All three exceed the ctx so the ctx cancels first". Both the
// comment and the ordering were wrong:
//
//  1. The stated 40m base is HETZNER's — 25m waitTimeout + 8m ArgoCD + 7m headroom. Every managed
//     cloud has a 50m waitTimeout (t2ProviderTable), and the soak is on by default from the workflow
//     (`vars.E2E_SOAK || '10m'` ⇒ 10m + 15m headroom). So a managed floor leg's real ctx is
//     50 + 8 + 25 + 7 = 90m, against a 75m STEP CAP. The ctx could not cancel first on any of the
//     four managed clouds; the step killed the process instead, which loses the named scenario
//     failure AND skips the in-process t.Cleanup teardown, leaking the cluster to the workflow
//     sweeper. It had not bitten only because gcp/azure/alibaba were dying fast at KMS (#2262).
//  2. `go test -timeout 80m` EXCEEDED the 75m step cap, so go's own timeout could never fire and
//     its goroutine dump — the thing that names which scenario hung — was unreachable by construction.
//
// The correct ordering is ctx < go-timeout < step < job, each margin serving a purpose:
//
//	ctx  cancels first  → the scenario reports its own bounded failure, and t.Cleanup tears down
//	go   +5m            → if the ctx is somehow not honored, go panics with a stack naming the test
//	step +5m            → if go is wedged, the step kills it and the run still reaches teardown
//	job  +15m           → teardown, proof capture and the scrub all run after the step is done
//
// ResolveT2Budget is the ONE definition. The tagged cloud test derives its ctx from it, the workflow
// derives its step and go-timeout from it (cmd/t2budget), and TestT2BudgetLadderHolds proves the
// ordering for every cloud × scenario combination on every PR. Numbers cannot drift from prose here,
// because there is no prose carrying a number.
const (
	t2GoTimeoutMargin = 5 * time.Minute
	t2StepMargin      = 5 * time.Minute
	t2JobMargin       = 15 * time.Minute

	// Runner build + snapshot seeding + the slack the old comment called "headroom".
	t2BaseHeadroom = 7 * time.Minute

	// Post-ArgoCD polling windows. Each is the scenario's own, and each exists because a ctx that
	// expired mid-poll is indistinguishable from the thing under test having never worked.
	t2XacctPollBudget    = 10 * time.Minute
	t2KeylessPostDwell   = 20 * time.Minute
	t2RegistryPollBudget = 25 * time.Minute
	t2SoakHeadroom       = 15 * time.Minute // drift wait (10m) + PVC bind (5m)
)

// T2BudgetTerm is one enabled scenario's contribution, kept named so a failure can say which
// scenario's window blew the ladder rather than printing one opaque total.
type T2BudgetTerm struct {
	Scenario string
	D        time.Duration
}

// T2Budget is the resolved ladder for one leg.
type T2Budget struct {
	Provider  string
	Terms     []T2BudgetTerm
	Ctx       time.Duration
	GoTimeout time.Duration
	Step      time.Duration
	Job       time.Duration
}

// Describe renders the ladder for a log line or a step summary.
func (b T2Budget) Describe() string {
	parts := make([]string, 0, len(b.Terms))
	for _, t := range b.Terms {
		parts = append(parts, fmt.Sprintf("%s %s", t.Scenario, t.D))
	}
	return fmt.Sprintf("%s: ctx %s (= %s) < go %s < step %s < job %s",
		b.Provider, b.Ctx, strings.Join(parts, " + "), b.GoTimeout, b.Step, b.Job)
}

// ResolveT2Budget computes the ladder from the environment the leg will actually run with. env is the
// environment slug, needed only because the fabric-demo term scales with its parsed overlay tiers.
//
// Enablement is read from each scenario's own predicate rather than from its richer decide() result:
// a scenario that is configured but turns out BLOCKED (a documented per-cloud exclusion) simply does
// not spend its budget, and over-allocating a ceiling is harmless. Under-allocating is the bug.
func ResolveT2Budget(provider, env string) (T2Budget, error) {
	p, ok := t2LookupProvider(provider)
	if !ok {
		return T2Budget{}, fmt.Errorf("no T2 provider row for %q — add it to t2ProviderTable", provider)
	}

	b := T2Budget{Provider: provider}
	add := func(name string, d time.Duration) {
		if d > 0 {
			b.Terms = append(b.Terms, T2BudgetTerm{Scenario: name, D: d})
		}
	}

	add("deploy-wait", resolveT2WaitTimeout(p))
	add("argocd-converge", ArgoAssertTimeout())

	soakDur, soakOn, err := parseSoakDuration(os.Getenv("ALETHIA_E2E_SOAK"))
	if err != nil {
		return T2Budget{}, err
	}
	if soakOn {
		add("soak", soakDur+t2SoakHeadroom)
	}
	if secretsXacctEnabled() {
		add("secrets-xacct", t2XacctPollBudget)
	}
	if keylessDBEnabled() {
		add("keyless-db", keylessDBFromEnv(provider).dwell+t2KeylessPostDwell)
	}
	if xacctRegistryEnabled() {
		add("xacct-registry", t2RegistryPollBudget)
	}
	if namespaceTenantEnabled() {
		add("namespace-placement", namespaceTenantBudget)
	}
	if vclusterTenantEnabled() {
		add("vcluster-placement", vclusterTenantBudget)
	}
	if fabricDemoEnabled() {
		tiers, tErr := fabricDemoTiers(env, provider)
		if tErr != nil {
			return T2Budget{}, fmt.Errorf("fabric-demo (#845): %w", tErr)
		}
		d := fabricDemoTimeout()
		add("fabric-demo", time.Duration(len(tiers))*2*d+d+vclusterTenantBudget)
	}
	add("headroom", t2BaseHeadroom)

	for _, t := range b.Terms {
		b.Ctx += t.D
	}
	// Whole minutes, rounded UP: the workflow's timeout-minutes is an integer, and truncating would
	// invert the very ordering this function exists to guarantee.
	b.GoTimeout = ceilMinutes(b.Ctx + t2GoTimeoutMargin)
	b.Step = ceilMinutes(b.GoTimeout + t2StepMargin)
	b.Job = ceilMinutes(b.Step + t2JobMargin)
	return b, nil
}

// ceilMinutes rounds a duration up to a whole number of minutes.
func ceilMinutes(d time.Duration) time.Duration {
	return time.Duration(math.Ceil(d.Minutes())) * time.Minute
}

// T2BudgetScenarioEnv lists every env var ResolveT2Budget reads to decide a term, so the ladder test
// can enumerate combinations without hard-coding a list that would silently fall behind a new
// scenario. Sorted for a deterministic test order.
func T2BudgetScenarioEnv() []string {
	vars := []string{
		"ALETHIA_E2E_SOAK",
		envSecretsXacct,
		envKeylessDB,
		envXacctRegistry,
		"ALETHIA_E2E_NAMESPACE_TENANT",
		"ALETHIA_E2E_VCLUSTER",
		envFabricDemo,
	}
	sort.Strings(vars)
	return vars
}
