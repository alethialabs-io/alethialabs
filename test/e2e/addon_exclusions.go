// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
)

// Which catalog add-ons the `addons` dimension does not require to converge, and WHY.
//
// #2717 measured the full surface honestly for the first time — 11 of 22 Applications not
// Healthy+Synced — and several of those cannot converge AT CATALOG DEFAULTS by design: they need a
// value only a customer can supply. Asserting them anyway makes the dimension unpassable for a
// reason that is not a defect, and a bar that cannot be passed stops being read.
//
// So the claim is narrowed to something provable and still worth proving:
//
//	every add-on that CAN install unattended does.
//
// Deliberately NOT the other repair — seeding a bucket for velero, unsealing vault, pasting a
// Cloudflare token. That would make all eighteen green while stopping the fixture from representing
// what a customer actually gets, and a default-install regression is the one most likely to reach a
// customer.
//
// Two properties keep this from becoming a way to hide failures:
//
//  1. An exclusion carries a WHY and an ISSUE, enforced by a test. maxconfig.go settles the same
//     question the same way: an exclusion nobody can read is indistinguishable from an oversight.
//  2. An excluded add-on is still INSTALLED and still OBSERVED. If one turns out Healthy+Synced,
//     the run goes RED for a STALE EXCLUSION — the same ratchet the CLI-demo bar applies to a
//     closed gap (t2_cli_demo_run_test.go), for the same reason: an exclusion left standing after
//     the thing starts working understates the product.
//
// This is NOT the place for a chart that merely fails. "Broken" and "needs a customer" are
// different facts, and only the second one belongs here.

// AddOnExclusionKind names the REASON an add-on is withheld. It is a typed kind rather than a bare
// comment so a second reason cannot be added by writing prose that nothing reads.
type AddOnExclusionKind string

const (
	// NeedsUserConfig — the chart needs a value only a CUSTOMER can supply: a bucket, an unseal
	// key, an API token. Not a cloud ceiling (every cloud would host it fine) and not a product
	// defect (the catalog offers the knob) — simply not exercisable by a fixture that seeds
	// catalog defaults.
	NeedsUserConfig AddOnExclusionKind = "needs-user-config"
)

// AddOnExclusion is one withheld add-on's record.
type AddOnExclusion struct {
	Kind AddOnExclusionKind
	// Why must say what a CUSTOMER would have to supply, in enough detail that a reader can decide
	// whether the exclusion is still true without re-deriving it.
	Why string
	// Issue is the tracking issue, so an exclusion cannot become permanent by being forgotten.
	Issue string
}

// addOnExclusions is keyed on the CATALOG ID (not the Application name), because that is the
// identifier the catalog fixture and the console share. A test pins every key against the catalog,
// so an exclusion for an add-on that was renamed or removed fails the build instead of silently
// excluding nothing.
var addOnExclusions = map[string]AddOnExclusion{
	"vault": {
		Kind: NeedsUserConfig,
		Why: "a fresh Vault starts SEALED: its readiness probe never passes, the pod is never Ready, " +
			"and the Application sits Progressing at any budget. The catalog's config schema offers " +
			"`ui` and `ha` and no init/unseal knob, and the marketplace chart deliberately ships no " +
			"bootstrap Job — packages/core/argocd/vault.go keeps that on the PLATFORM Vault only. " +
			"Initialising and unsealing is a customer operation with a customer's key material.",
		Issue: "#2717",
	},
	"velero": {
		Kind: NeedsUserConfig,
		Why: "backups need a real object-store BUCKET plus credentials for it. With the catalog's " +
			"empty `bucket` default the values carry no backupStorageLocation at all, so nothing " +
			"can reconcile. It is also the one add-on with a cloud-shaped gap: the `provider` enum " +
			"is aws|gcp|azure, so on hetzner there is no valid choice even WITH a bucket.",
		Issue: "#2717",
	},
	"external-dns": {
		Kind: NeedsUserConfig,
		Why: "the catalog default is provider=cloudflare with an empty apiToken, so the chart gets " +
			"no credential. Switching it to provider=aws does NOT rescue it: the marketplace " +
			"add-on renders as `addon-external-dns` and its schema has only provider/domainFilter/" +
			"apiToken — no serviceAccount and no annotation knob — so it cannot reach the IRSA role " +
			"the template binds to the PLATFORM external-dns's `external-dns-sa`. That is the same " +
			"reason cert-manager was removed from the catalog: an add-on cannot see the cloud " +
			"identity, the zone, or the provider.",
		Issue: "#2734",
	},
}

// excludedAddOnAppNames maps ArgoCD Application name → exclusion, derived through
// argocd.AddOnAppName so this file can never disagree with the renderer about what an add-on's
// Application is called.
func excludedAddOnAppNames() map[string]AddOnExclusion {
	out := make(map[string]AddOnExclusion, len(addOnExclusions))
	for id, e := range addOnExclusions {
		out[argocd.AddOnAppName(id)] = e
	}
	return out
}

// PartitionExcludedAddOns splits a derived expected-Application set into the ones whose health is
// ASSERTED and the ones WITHHELD by an exclusion.
//
// Call it AFTER RequireAllAddOnsExpected, never before: that guard's whole job is to prove the
// derived set still covers the catalog, and handing it a pre-filtered set would make it agree with
// a set that had already dropped the very add-ons it exists to count.
func PartitionExcludedAddOns(expected []string) (asserted, withheld []string) {
	ex := excludedAddOnAppNames()
	for _, name := range expected {
		if _, isExcluded := ex[name]; isExcluded {
			withheld = append(withheld, name)
			continue
		}
		asserted = append(asserted, name)
	}
	sort.Strings(withheld)
	return asserted, withheld
}

// DescribeWithheldAddOns renders the withheld set for the run log, so a reader of a GREEN run can
// see exactly what it did not assert. A verdict whose exclusions are invisible reads as a wider
// claim than it is.
func DescribeWithheldAddOns(withheld []string) string {
	if len(withheld) == 0 {
		return "no add-ons withheld: every catalog add-on's health is asserted"
	}
	ex := excludedAddOnAppNames()
	var b strings.Builder
	fmt.Fprintf(&b, "%d add-on(s) WITHHELD from the health assertion (installed and observed, but not required to converge):", len(withheld))
	for _, name := range withheld {
		e := ex[name]
		fmt.Fprintf(&b, "\n  - %s [%s] %s — %s", name, e.Kind, e.Issue, e.Why)
	}
	return b.String()
}

// AssertNoStaleAddOnExclusions fails when a WITHHELD add-on is actually Healthy+Synced.
//
// A single read, not a poll: staleness does not resolve by waiting, and spending the ArgoCD budget
// re-asking would cost a real run up to twenty minutes to learn something the first answer already
// gave. Run it after the health assertion has passed, when the cluster has settled.
//
// Red on purpose. An add-on that has started converging must come OFF this list — otherwise the
// list grows monotonically and the dimension quietly asserts less every release.
func AssertNoStaleAddOnExclusions(ctx context.Context, kubeconfigPath string, withheld []string) error {
	if len(withheld) == 0 {
		return nil
	}
	raw, err := kubectlGetArgoApps(ctx, kubeconfigPath)
	if err != nil {
		// Fail-closed: an unreadable cluster is not evidence that every exclusion is still needed.
		return fmt.Errorf("stale-exclusion check could not list ArgoCD Applications, so no exclusion could be re-validated: %w", err)
	}
	observed, err := parseArgoApps(raw)
	if err != nil {
		return fmt.Errorf("stale-exclusion check could not parse ArgoCD Applications: %w", err)
	}
	stale := staleExclusions(observed, withheld)
	if len(stale) == 0 {
		return nil
	}
	sort.Strings(stale)
	return fmt.Errorf(
		"%d add-on(s) are recorded as unable to converge at catalog defaults, but reached Healthy+Synced in this run:\n  - %s\n"+
			"Remove them from addOnExclusions and close the issue: an exclusion left standing after the thing works understates the product, "+
			"and every run after this one would assert less than it could",
		len(stale), strings.Join(stale, "\n  - "))
}

// staleExclusions is the DECISION, split out so it can be tested without a cluster.
//
// Only Healthy AND Synced counts as "this works now". A chart that is Healthy but OutOfSync is
// exactly the spurious-diff class the Application template's ignoreDifferences handles, and a
// Progressing one may simply not have finished — neither is evidence the exclusion is wrong, and
// treating either as stale would red a run for the opposite of the reason this check exists.
func staleExclusions(observed map[string]argoAppState, withheld []string) []string {
	ex := excludedAddOnAppNames()
	var stale []string
	for _, name := range withheld {
		st, ok := observed[name]
		if !ok {
			// Absent is not working. A withheld add-on that never rendered an Application says
			// nothing about whether its exclusion is still needed.
			continue
		}
		if st.Health == "Healthy" && st.Sync == "Synced" {
			stale = append(stale, fmt.Sprintf("%s (%s, recorded as: %s)", name, ex[name].Issue, ex[name].Why))
		}
	}
	return stale
}
