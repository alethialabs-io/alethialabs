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
// AN EXCLUSION IS PER CLOUD, and that is not a generalisation for its own sake — it is what the
// tree turned out to require. #3048 made the add-on fixture per cloud and resolved external-dns's
// NATIVE provider through the real emitter, and hetzner's resolved shape (the webhook sidecar)
// CONVERGES where aws/gcp/azure/alibaba's do not. A global list would have had to either red the
// hetzner run for an exclusion that is no longer true, or withhold on four clouds a fact measured
// on one. Neither is a thing this file may say. Both properties above still hold per cloud: the
// WHY is still enforced, and the ratchet still fires on the clouds an entry actually claims.
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
	// Issue is the tracking issue, so an exclusion cannot become permanent by being forgotten. It
	// must be OPEN: a CLOSED issue defeats the whole point of the field, and that is not
	// hypothetical — external-dns cited #2734 for two days after #2777 closed it by fixing the very
	// gap the Why described.
	Issue string
	// Clouds narrows the exclusion to the clouds it is actually TRUE on. Empty means every cloud.
	//
	// This exists because the fixture went per-cloud in #3048 and the truth went with it. Before
	// that, one cloud-agnostic fixture pointed external-dns at Cloudflare everywhere, so one global
	// answer was the right shape. Now each cloud gets its own native provider, and hetzner's
	// resolves to a shape that CONVERGES while the others do not — a fact a global list cannot
	// express without lying about one cloud or the other.
	//
	// A POSITIVE list, not an exemption list, so a cloud nobody has measured is ASSERTED rather
	// than silently inheriting an exclusion derived from a different cloud's behaviour. That is the
	// fail-loud direction: an unmeasured cloud that cannot converge reds with the chart named,
	// which is a question someone can answer, whereas a silently-inherited exclusion is the
	// monotonic growth this whole file exists to prevent.
	Clouds []string
}

// addOnExclusions is keyed on the CATALOG ID (not the Application name), because that is the
// identifier the catalog fixture and the console share. A test pins every key against the catalog,
// so an exclusion for an add-on that was renamed or removed fails the build instead of silently
// excluding nothing.
var addOnExclusions = map[string]AddOnExclusion{
	"vault": {
		Kind: NeedsUserConfig,
		Why: "a fresh Vault starts SEALED: its readiness probe never passes, the pod is never Ready, " +
			"and the Application sits Progressing at any budget — measured health=Progressing " +
			"sync=OutOfSync on run 33124236998. The catalog's config schema offers " +
			"`ui` and `ha` and no init/unseal knob, and the marketplace chart deliberately ships no " +
			"bootstrap Job — packages/core/argocd/vault.go keeps that on the PLATFORM Vault only. " +
			"Initialising and unsealing is a customer operation with a customer's key material.",
		Issue: "#2717",
	},
	"velero": {
		Kind: NeedsUserConfig,
		Why: "backups need a real object-store BUCKET plus credentials for it. With the catalog's " +
			"empty `bucket` default `toValues` emits no backupStorageLocation at all, so nothing " +
			"can reconcile — measured health=Missing on run 33124236998. It is also the one add-on " +
			"with a cloud-shaped gap: the `provider` enum is aws|gcp|azure, so on hetzner AND on " +
			"alibaba there is no valid choice even WITH a bucket. (alibaba joined the fixture " +
			"clouds in #3048; it has the same gap hetzner does and the note used to name only " +
			"hetzner.)",
		Issue: "#2717",
	},
	// NOT hetzner — MEASURED. Run 33124236998 (hetzner · `addons`, 2026-08-28, the first sweep
	// after #3048) reported `addon-external-dns: health=Healthy sync=Synced`. It escaped the
	// stale-exclusion ratchet only because that run t.Fatal'd at the convergence assertion in
	// t2_provision_test.go — five Applications short, on falco/harbor/kyverno/loki/tempo — and so
	// never reached AssertNoStaleAddOnExclusions below it. See Clouds below.
	"external-dns": {
		Kind: NeedsUserConfig,
		Why: "the fixture seeds CATALOG DEFAULTS, and both credential knobs default to empty. " +
			"#3048 repointed it at each cloud's NATIVE provider (aws→aws, gcp→google, azure→azure) " +
			"so the old reason — `provider=cloudflare` everywhere — is dead, and #2777 added the " +
			"`workloadIdentity` knob the old reason said the schema lacked. What is left is that " +
			"nothing FILLS either knob: `toValues` gates the serviceAccount block on " +
			"`p.saAnnotation && c.workloadIdentity`, and `secretValues` returns {} with no apiToken " +
			"ref, so the controller runs with a provider name and no identity and no token. " +
			"external-dns 1.15.0 then log.Fatalf's `Failed to do run once` on the provider error " +
			"and CrashLoops — measured on the PLATFORM rail at the same chart version, health=" +
			"Degraded both times: gcp 403 (#2811, run 32959925920) and azure config-file (#2868, " +
			"run 33001235713). alibaba is a fourth case with the same outcome: " +
			"EXTERNAL_DNS_NATIVE_PROVIDER has no entry for it, so its fixture still carries " +
			"provider=cloudflare with no token. Supplying an IAM role ARN / GSA email / client id, " +
			"or a provider API token, is a CUSTOMER action. UNVERIFIED on these four since #3048: " +
			"the only add-on sweep that has run since it merged was hetzner's, which is exactly " +
			"the cloud this exclusion no longer covers.",
		Issue:  "#2717",
		Clouds: []string{"aws", "gcp", "azure", "alibaba"},
	},
}

// excludedAddOnAppNames maps ArgoCD Application name → exclusion FOR ONE CLOUD, derived through
// argocd.AddOnAppName so this file can never disagree with the renderer about what an add-on's
// Application is called.
//
// An entry whose Clouds list does not name this cloud is simply absent from the result, which is
// what makes it asserted: every consumer below decides by presence in this map.
func excludedAddOnAppNames(cloud string) map[string]AddOnExclusion {
	out := make(map[string]AddOnExclusion, len(addOnExclusions))
	for id, e := range addOnExclusions {
		if !e.appliesTo(cloud) {
			continue
		}
		out[argocd.AddOnAppName(id)] = e
	}
	return out
}

// appliesTo reports whether this exclusion holds on `cloud`. An empty Clouds list means every
// cloud — the common case, and the one vault and velero use.
func (e AddOnExclusion) appliesTo(cloud string) bool {
	if len(e.Clouds) == 0 {
		return true
	}
	for _, c := range e.Clouds {
		if c == cloud {
			return true
		}
	}
	return false
}

// PartitionExcludedAddOns splits a derived expected-Application set into the ones whose health is
// ASSERTED and the ones WITHHELD by an exclusion.
//
// Call it AFTER RequireAllAddOnsExpected, never before: that guard's whole job is to prove the
// derived set still covers the catalog, and handing it a pre-filtered set would make it agree with
// a set that had already dropped the very add-ons it exists to count.
// The split is PER CLOUD (#3048 made the fixture per cloud and the truth followed it): an add-on
// withheld on aws may be asserted on hetzner, and passing the wrong cloud here would assert an
// add-on that cannot converge or withhold one that already does.
func PartitionExcludedAddOns(cloud string, expected []string) (asserted, withheld []string) {
	ex := excludedAddOnAppNames(cloud)
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
func DescribeWithheldAddOns(cloud string, withheld []string) string {
	if len(withheld) == 0 {
		return "no add-ons withheld: every catalog add-on's health is asserted"
	}
	ex := excludedAddOnAppNames(cloud)
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
func AssertNoStaleAddOnExclusions(ctx context.Context, kubeconfigPath, cloud string, withheld []string) error {
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
	stale := staleExclusions(observed, cloud, withheld)
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
func staleExclusions(observed map[string]argoAppState, cloud string, withheld []string) []string {
	ex := excludedAddOnAppNames(cloud)
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
