// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// AZURE MANAGED REDIS PRE-SPEND PREFLIGHT — the `cache` kind's own capacity gate.
//
// WHY AZURE NEEDS ITS OWN PROBE ALONGSIDE THE gcp/aws/hetzner ONES IN t2_preflight.go.
// Those four all answer ONE question — "will this cloud sell us this COMPUTE shape here?" —
// and they are enough for the clusters they guard. They are blind to everything the run
// provisions that is not a node, and Azure has now killed two paid applies on exactly that
// blind spot:
//
//	32836351919  germanywestcentral  Azure Managed Redis: InsufficientCapacity
//	33108860073  westeurope          Azure Managed Redis: InsufficientCapacity  (#3078)
//
// The second one is the argument for this file. Its VM preflight PASSED and said so —
//
//	pre-spend capacity preflight [PROCEED]: "Standard_E2s_v3" is available in westeurope
//
// — and the run then built an AKS cluster and its networking for ~1724s before
// `azurerm_managed_redis` came back `Status: "Failed" Code: "InsufficientCapacity"`, mid-apply,
// with `orphan risk: likely`. A green compute preflight is not a statement about Managed Redis:
// it is a different service, with a different regional capacity pool, sold under a different
// quota. gcp's Memorystore and aws's ElastiCache have never refused a run this way, which is
// why they are not wired here — see t2RequireAzureManagedRedisPreflight for the per-cloud
// reasons, stated rather than left to an unnamed default.
//
// THREE VERDICTS, NEVER TWO — the same contract as t2_preflight.go, deliberately reusing its
// preflightResult/preflightVerdict rather than inventing a second mechanism:
//
//	PROCEED  nothing known says this (region, sku) is broken, and the cloud offers the
//	         resource type in this region
//	REFUSE   something ANSWERED "no" — a measured failure of this exact pair, or the cloud
//	         itself saying Microsoft.Cache/redisEnterprise is not offered in this region
//	UNKNOWN  the probe did not answer — proceed, loudly, and record that nothing was checked
//
// WHAT MAKES THIS PROBE DIFFERENT FROM ITS SIBLINGS, and it matters: **Azure exposes no
// read-only capacity API for Microsoft.Cache/redisEnterprise.** The resource provider lists the
// LOCATIONS it offers the type in, which is availability, not capacity — westeurope is listed
// and still cannot allocate. So availability alone would have PROCEEDed on the exact run this
// file exists to stop. The gate therefore has two legs:
//
//	leg 1  a LEDGER of measured (region, sku) failures — the only capacity signal that exists
//	leg 2  the cloud's own location list — which catches a region that cannot host it at all
//
// Leg 1 runs FIRST and does not depend on leg 2, because a probe outage must not silently
// discard the one fact we actually paid to learn. Leg 2's answer never overwrites leg 1's; it
// is appended, so a caveat annotates the verdict instead of replacing it.
package e2e

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// azureRedisResourceType is the ARM resource type azurerm_managed_redis creates. Named here
// because the probe's whole answer turns on the spelling: `az provider show` filters on it, and
// a type that matches nothing yields JSON null, which is UNKNOWN — never a refusal.
//
// It is `redisEnterprise` and not `redis`: `Microsoft.Cache/redis` is the RETIRED Azure Cache
// for Redis, which Azure now refuses to create outright (see
// infra/templates/project/azure/modules/azure-cache-redis/main.tf). Asking about the retired
// type would answer a question no run asks.
const azureRedisResourceType = "redisEnterprise"

// azureRedisPreflightTimeout bounds the location read.
//
// `az provider show` returns one resource provider's metadata — far smaller than the 1114-SKU
// virtualMachines enumeration azurePreflightTimeout was raised for — but it is the same binary
// on the same runner, and that raise exists because the previous 30s bound killed `az` on every
// azure run while the gate reported UNKNOWN and never once ran. The cost of an over-generous
// bound is paid only when the probe is already failing; the cost of a tight one is a gate that
// is silently inert on a whole cloud. Same bound, same reason.
const azureRedisPreflightTimeout = azurePreflightTimeout

// azureRedisAllowKnownBadEnv is the ESCAPE HATCH, and it is deliberately narrow.
//
// The ledger records what a paid run measured on a date. Capacity comes back; a maintainer must
// be able to re-test westeurope without editing this file or disabling the gate wholesale. When
// set, a ledger hit stops being a refusal and becomes an annotation on whatever the cloud says.
//
// It does NOT lift leg 2. "This subscription's RP does not offer redisEnterprise in this region"
// is not a capacity observation that might have expired, and the flag's name does not cover it.
const azureRedisAllowKnownBadEnv = "ALETHIA_E2E_AZURE_REDIS_ALLOW_KNOWN_BAD"

// azureRedisCapacityFact is ONE measured observation about Managed Redis capacity in one region.
//
// Every field is evidence, not judgement. `SKUs` lists the skus a real apply actually requested
// and was refused — it is not a claim about skus nobody has tried, which is why an unmeasured
// sku in a listed region WARNS rather than refuses. Over-refusing is the failure mode that gets
// a guard switched off, and it takes the real refusals with it.
type azureRedisCapacityFact struct {
	// Region is the azure region slug (westeurope), as the workflow's `region` input spells it.
	Region string
	// SKUs are the Managed Redis skus OBSERVED to fail in this region. Matching is exact.
	SKUs []string
	// Evidence names the run and the date, so a reader can re-read the log rather than trust
	// this table. A fact with no evidence is an opinion.
	Evidence string
}

// azureRedisKnownBad is the ledger — leg 1, and the leg that catches #3078.
//
// It exists because Azure publishes no capacity read for this resource type. That was checked
// before this file was written, not assumed: `Microsoft.Cache` lists resourceTypes[].locations,
// which says where the type is OFFERED. westeurope is on that list and still answered
// InsufficientCapacity, so an availability-only gate would have waved the failing run through.
//
// KEEPING IT HONEST: an entry is added only from a run log, with its id, and removed when a run
// proves the pair provisions again. It is not a policy list and it must never grow a guess.
var azureRedisKnownBad = []azureRedisCapacityFact{
	{
		Region: "westeurope",
		SKUs:   []string{"Balanced_B0", "Balanced_B1"},
		Evidence: "run 33108860073 (2026-08-27) asked for Balanced_B0 — the SMALLEST sku Azure Managed Redis " +
			"offers — and got `polling after Create: Status \"Failed\" Code \"InsufficientCapacity\"` ~1724s into a " +
			"paid apply, with orphan risk likely (#3078). Follow-up probes recorded on #3078 refused Balanced_B1 " +
			"here too, and refused identically with high availability DISABLED, so neither dropping a tier nor " +
			"dropping zone redundancy is a way out of this region",
	},
	{
		Region: "germanywestcentral",
		SKUs:   []string{"Balanced_B1"},
		Evidence: "run 32836351919 — the first azure full bar — died on Azure Managed Redis with " +
			"`InsufficientCapacity: retry using a different size or region`; that run predates #1993, so its " +
			"NumCacheNodes=2 still flipped the legacy tier to Standard and the template resolved Balanced_B1. " +
			"It is the reason the row's default region was moved to westeurope in the first place " +
			"(test/e2e/t2_providers.go), which is how the same failure was bought twice",
	},
}

// azureRedisKnownGoodHint names a region an azure apply has actually completed in, so a refusal
// can say where to go rather than only where not to be.
//
// Scoped exactly to what the artifact supports: run 33115079834 (workflow_dispatch, conclusion
// `success`, 2026-08-27) applied 57 resources in swedencentral and destroyed cleanly —
// demos/proofs/azure/20260827T211849Z. The bundle does not itself name the `cache` kind, so this
// is "an azure apply completed here", NOT "Managed Redis is proven here". It is a hint in a
// message, never a ledger entry, and nothing decides on it.
const azureRedisKnownGoodHint = "swedencentral — run 33115079834 (2026-08-27) applied 57 resources there and destroyed cleanly " +
	"(demos/proofs/azure/20260827T211849Z); the bundle does not itself name the cache kind, so this says an azure " +
	"apply completes there, not that Managed Redis is proven there"

// normalizeAzureLocation folds an azure location to its comparable form.
//
// THIS IS THE TRAP IN THIS FILE. `az provider show` answers in DISPLAY names ("West Europe"),
// while every region this repo passes around is a slug ("westeurope"). Comparing them raw makes
// EVERY region miss the offered list, which turns leg 2 into a blanket REFUSE — a guard that
// blocks every azure run while looking like it is working. Both forms are folded here and both
// are unit-tested, in both directions.
func normalizeAzureLocation(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(strings.TrimSpace(s)) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// lookupAzureRedisKnownBad asks the ledger about one (region, sku) pair.
//
// Returns:
//
//	exact == true   this SKU was itself measured to fail in this region  → a REFUSAL
//	fact != nil     the region has a measured failure on a DIFFERENT sku → a WARNING only
//	fact == nil     the ledger has nothing to say about this region
//
// The two are separated on purpose. "Balanced_B0 was refused in westeurope" is a fact; "no
// Managed Redis sku can be created in westeurope" is an extrapolation from it, and this guard
// does not refuse on extrapolations — it says them out loud instead.
func lookupAzureRedisKnownBad(region, sku string) (fact *azureRedisCapacityFact, exact bool) {
	wantRegion := normalizeAzureLocation(region)
	wantSKU := strings.TrimSpace(sku)
	for i := range azureRedisKnownBad {
		f := &azureRedisKnownBad[i]
		if normalizeAzureLocation(f.Region) != wantRegion {
			continue
		}
		for _, s := range f.SKUs {
			if strings.EqualFold(strings.TrimSpace(s), wantSKU) {
				return f, true
			}
		}
		fact = f
	}
	return fact, false
}

// azureRedisAvailabilityCaveat is appended to EVERY non-refusing verdict.
//
// Not decoration. A reader who sees PROCEED on a capacity gate reasonably concludes capacity was
// checked, and here it cannot be: the strongest thing leg 2 can establish is that the resource
// type is sold in this region. westeurope satisfies that and still cannot allocate. Saying so on
// the success branch is the difference between "capacity is fine" and "nothing known says
// otherwise", and only the second one is true.
const azureRedisAvailabilityCaveat = " CAVEAT: Azure publishes no read-only CAPACITY api for " +
	"Microsoft.Cache/redisEnterprise — only the locations it is OFFERED in. westeurope is offered and still " +
	"answered InsufficientCapacity, so this verdict means \"nothing known says this will fail\", NOT \"capacity is " +
	"confirmed\". A capacity refusal can still land in the apply."

// decideAzureManagedRedisCapacity is the PURE core: every branch of the verdict is decided here,
// against values a test can hand it, so none of it depends on a cloud, a CLI or a credential.
//
// `offered` carries the same nil-vs-empty distinction the rest of the preflight turns on:
//
//   - nil   the probe produced no list        → UNKNOWN
//   - []    the RP offers the type NOWHERE    → REFUSE
//   - [..]  a real list                       → PROCEED / REFUSE by membership
//
// The empty case is an ANSWER here for a checkable reason, not by analogy: the probe's JMESPath
// (`resourceTypes[?resourceType=='<t>'].locations | [0]`) yields JSON *null* when the type
// matches nothing, and preflightCLIStrings turns null into an error. So `[]` can only be reached
// by the type matching and its own location list being empty.
func decideAzureManagedRedisCapacity(probe, region, sku string, offered []string, probeErr error, allowKnownBad bool) preflightResult {
	r := preflightResult{Probe: probe}

	if strings.TrimSpace(sku) == "" {
		// Nothing to check is not the same as a clean check — the same refusal
		// decideTypeAvailability makes for an unresolved machine type.
		r.Verdict = preflightUnknown
		r.Detail = fmt.Sprintf("no Managed Redis sku was resolved for %s, so nothing was checked", region)
		return r
	}
	if normalizeAzureLocation(region) == "" {
		// A region that folds to nothing matches no offered location, so leg 2 below would REFUSE
		// it — a refusal caused by our own missing input rather than by anything the cloud said.
		// That is the wrong direction for this guard to fail in, and it is caught here rather than
		// left to the membership test to get accidentally right.
		r.Verdict = preflightUnknown
		r.Detail = fmt.Sprintf("no azure region was resolved, so Managed Redis sku %q was checked against nothing", sku)
		return r
	}

	// ── leg 1: the ledger, FIRST ────────────────────────────────────────────────────────────
	// Before the cloud read and independent of it. This is the only capacity signal that
	// exists; losing it because a CLI timed out would leave the gate unable to catch the one
	// failure it was built for.
	fact, exact := lookupAzureRedisKnownBad(region, sku)
	if exact && !allowKnownBad {
		r.Verdict = preflightRefuse
		r.Detail = fmt.Sprintf(
			"Managed Redis sku %q in %s is a MEASURED failure, refused before any spend: %s. "+
				"Azure's own remedy text names the only two levers — a different size, or a different region. "+
				"Known to work: %s. To re-test this pair anyway (capacity does come back), set %s=1 — the run then "+
				"proceeds and this becomes a warning.",
			sku, region, fact.Evidence, azureRedisKnownGoodHint, azureRedisAllowKnownBadEnv)
		return r
	}

	// ── leg 2: what the cloud itself says ───────────────────────────────────────────────────
	switch {
	case probeErr != nil:
		r.Verdict = preflightUnknown
		r.Detail = fmt.Sprintf("could not ask azure whether Microsoft.Cache/%s is offered in %s (%v) — proceeding UNVERIFIED; sku %q was NOT checked against the cloud",
			azureRedisResourceType, region, probeErr, sku)
	case offered == nil:
		r.Verdict = preflightUnknown
		r.Detail = fmt.Sprintf("the Microsoft.Cache/%s location probe returned no list at all — proceeding UNVERIFIED; %q in %s was NOT checked against the cloud",
			azureRedisResourceType, sku, region)
	case len(offered) == 0:
		r.Verdict = preflightRefuse
		r.Detail = fmt.Sprintf("this subscription's Microsoft.Cache provider offers %s in NO location at all, so %q cannot be created in %s or anywhere else — refused before any spend",
			azureRedisResourceType, sku, region)
	default:
		if azureLocationOffered(offered, region) {
			r.Verdict = preflightProceed
			r.Detail = fmt.Sprintf("Microsoft.Cache/%s is offered in %s (the subscription lists %d location(s) for it), and no measured failure is recorded for sku %q there.",
				azureRedisResourceType, region, len(offered), sku)
		} else {
			r.Verdict = preflightRefuse
			r.Detail = fmt.Sprintf("Microsoft.Cache/%s is NOT offered in %s for this subscription — the apply cannot create %q there. Offered in: %s. Refused before any spend.",
				azureRedisResourceType, region, sku, renderOffer(offered))
		}
	}

	// ── annotations: APPENDED, never a branch that replaces the verdict ─────────────────────
	// A caveat written as another `case` silently discards the finding it was meant to qualify.
	// These only ever add sentences to a verdict that has already been decided above.
	if r.Verdict == preflightProceed {
		r.Detail += azureRedisAvailabilityCaveat
	}
	if fact != nil && !exact {
		r.Detail += fmt.Sprintf(" WARNING: %s has a measured Managed Redis capacity failure on %s — %s. Sku %q has not been tried here, so this is not refused, but it is not a fresh region either.",
			fact.Region, strings.Join(fact.SKUs, ", "), fact.Evidence, sku)
	}
	if exact && allowKnownBad {
		r.Detail += fmt.Sprintf(" OVERRIDE IN EFFECT (%s): %q in %s is a MEASURED failure — %s — and would normally be refused here. The run continues because you asked it to; if the apply dies on capacity, this is why.",
			azureRedisAllowKnownBadEnv, sku, region, fact.Evidence)
	}
	return r
}

// azureLocationOffered reports whether the target region appears in the RP's location list,
// comparing on the folded form so a display name and a slug match. See normalizeAzureLocation.
func azureLocationOffered(offered []string, region string) bool {
	want := normalizeAzureLocation(region)
	if want == "" {
		return false
	}
	for _, o := range offered {
		if normalizeAzureLocation(o) == want {
			return true
		}
	}
	return false
}

// azureManagedRedisPreflight performs the cloud read and hands it to the pure decision.
//
// The probe is `az provider show`, which is a read of the subscription's resource-provider
// metadata: no resource is created, nothing is billed, and it needs only the ARM_* credentials
// the run already has. The JMESPath projects one type's `locations` array so the answer arrives
// as a bare JSON array of strings — exactly the shape preflightCLIStrings decodes, including its
// handling of `null` (which is what a type that matched nothing produces) as an ERROR and not as
// an empty answer.
func azureManagedRedisPreflight(ctx context.Context, region, sku string) preflightResult {
	const probe = "az provider show --namespace Microsoft.Cache (resourceTypes[redisEnterprise].locations)"
	offered, err := preflightCLIStringsWithin(ctx, azureRedisPreflightTimeout, "az", "provider", "show",
		"--namespace", "Microsoft.Cache",
		"--query", "resourceTypes[?resourceType=='"+azureRedisResourceType+"'].locations | [0]",
		"--output", "json")
	return decideAzureManagedRedisCapacity(probe, region, sku, offered, err, azureRedisAllowKnownBad())
}

// azureRedisAllowKnownBad reads the escape hatch. Same truthiness rule as every other
// ALETHIA_E2E_* switch (t2Truthy), so `1`, `true`, `yes` and `on` all work and a typo does not
// silently disable a gate.
func azureRedisAllowKnownBad() bool { return t2Truthy(os.Getenv(azureRedisAllowKnownBadEnv)) }

// azureCacheLegacyTierToSKU MIRRORS local.azure_cache_sku_map in
// infra/templates/project/azure/azure-cache-redis.tf. When the control plane emits no exact
// sku, that map is what decides which Managed Redis tier the apply asks for — so a preflight
// that stopped at "the emitter said nothing" would report UNKNOWN on the very run this file
// exists to protect. #3078's run resolved its sku through exactly this path.
var azureCacheLegacyTierToSKU = map[string]string{
	"Basic":    "Balanced_B0",
	"Standard": "Balanced_B1",
	"Premium":  "Balanced_B3",
}

const (
	// azureCacheLegacyTierDefault mirrors variable "azure_cache_sku" (variables.tf) — Basic.
	azureCacheLegacyTierDefault = "Basic"
	// azureCacheSKUFallback mirrors the lookup()'s own default in azure-cache-redis.tf, which
	// applies when azure_cache_sku holds something the map does not carry.
	azureCacheSKUFallback = "Balanced_B0"
)

// azureCacheSKUFromTfvars resolves the sku the APPLY will request, from the tfvars the control
// plane actually emits.
//
// Mirrors the template's `coalesce(var.azure_cache_sku_name, lookup(azure_cache_sku_map,
// var.azure_cache_sku, "Balanced_B0"))`. Only the HCL half is mirrored — the ProjectConfig half
// is not re-derived here but taken from cloud.ProviderTfvars itself (see
// azureManagedRedisSKUFromSnapshot), because a guard that restates its emitter is a guard that
// drifts from it.
func azureCacheSKUFromTfvars(tf map[string]any) (sku, source string) {
	if s, ok := tf["azure_cache_sku_name"].(string); ok && strings.TrimSpace(s) != "" {
		return strings.TrimSpace(s), "azure_cache_sku_name, emitted by cloud.ProviderTfvars from caches[0]"
	}
	tier := azureCacheLegacyTierDefault
	tierSource := "the azure_cache_sku variable default"
	if t, ok := tf["azure_cache_sku"].(string); ok && strings.TrimSpace(t) != "" {
		tier, tierSource = strings.TrimSpace(t), "azure_cache_sku, emitted by cloud.ProviderTfvars"
	}
	if s, ok := azureCacheLegacyTierToSKU[tier]; ok {
		return s, fmt.Sprintf("the template's legacy tier map (%s = %q)", tierSource, tier)
	}
	return azureCacheSKUFallback, fmt.Sprintf("the template's lookup() fallback (%s = %q, which the tier map does not carry)", tierSource, tier)
}

// azureManagedRedisSKUFromSnapshot answers two questions off ONE call to the real emitter: will
// this run create a Managed Redis at all, and which sku will it ask for?
//
// It calls cloud.ProviderTfvars — the same function the runner's deploy path calls — rather than
// re-reading `caches[0]` by hand. That is the point: `create_azure_cache` is
// `len(config.Caches) > 0` and the sku comes from MemoryGB through the shared catalog, and both
// have moved before (#1993 withdrew NumCacheNodes on azure, which silently changed which tier a
// max-config run requests). A guard that re-derived them would have kept reporting the old sku.
//
// Returns creates=false when the run provisions no cache — a real state, and NOT an UNKNOWN:
// there is no Managed Redis to have capacity for.
func azureManagedRedisSKUFromSnapshot(snapshot map[string]any) (sku, source string, creates bool, err error) {
	raw, err := json.Marshal(snapshot)
	if err != nil {
		return "", "", false, fmt.Errorf("re-encoding the deploy snapshot: %w", err)
	}
	var cfg types.ProjectConfig
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return "", "", false, fmt.Errorf("decoding the deploy snapshot into types.ProjectConfig: %w", err)
	}
	p, err := cloud.NewCloudProvider("azure")
	if err != nil {
		return "", "", false, fmt.Errorf("resolving the azure provider: %w", err)
	}
	tf := p.ProviderTfvars(&cfg)
	if create, _ := tf["create_azure_cache"].(bool); !create {
		return "", "", false, nil
	}
	sku, source = azureCacheSKUFromTfvars(tf)
	return sku, source, true, nil
}

// t2RequireAzureManagedRedisPreflight is the PRE-SPEND gate for the `cache` kind on azure, and
// the sibling of t2RequireCapacityPreflight: that one asks whether the cloud will sell us the
// NODE shape here, this one asks whether it will sell us the CACHE.
//
// Same contract as every other T2 prerequisite: a REFUSE is fatal under ALETHIA_E2E_T2_REQUIRE
// (the nightly) and a warning off CI; an UNKNOWN is NEVER fatal and always speaks, so a green
// run is never read as one whose Managed Redis capacity was verified.
//
// Returns an EMPTY message — nothing logged at all — in exactly two not-applicable cases, and
// the emptiness is the point: a check that cannot apply must not print a verdict that reads like
// one that ran.
//
//	provider != azure   no other cloud has ever refused this run on cache capacity, and each
//	                    would need a different api. aws ElastiCache and gcp Memorystore: no
//	                    observed refusal, so there is nothing to encode and no ledger to seed.
//	                    hetzner: the cache is the upstream Valkey chart running IN-CLUSTER
//	                    (maxconfig.go), so there is no cloud capacity to ask about. alibaba: the
//	                    T2 row is blocked ahead of provisioning, the same named gap
//	                    capacityPreflightFor records for its VM probe.
//	no cache in the run the snapshot provisions no Managed Redis, so there is no capacity
//	                    question to answer. Not an UNKNOWN — UNKNOWN means "we could not find
//	                    out", and here there is nothing to find out.
func t2RequireAzureManagedRedisPreflight(ctx context.Context, provider, region string, snapshot map[string]any) (fatal bool, msg string) {
	if provider != "azure" {
		return false, ""
	}
	sku, source, creates, err := azureManagedRedisSKUFromSnapshot(snapshot)
	if err != nil {
		// A snapshot this guard cannot read is UNKNOWN and says so — it is NOT silence, which
		// would be indistinguishable from "this run creates no cache".
		return false, fmt.Sprintf("azure Managed Redis capacity preflight [%s]: could not resolve the sku this run will request (%v) — proceeding UNVERIFIED; nothing was checked",
			preflightUnknown, err)
	}
	if !creates {
		return false, ""
	}
	return azureRedisPreflightOutcome(azureManagedRedisPreflight(ctx, region, sku), sku, source)
}

// azureRedisPreflightOutcome turns a verdict into the (fatal, msg) contract every T2
// prerequisite shares.
//
// Split out from the wrapper above so the FATALITY rule is reachable by a unit test without a
// cloud, a CLI or a credential. It is the branch most worth pinning and the least likely to be
// exercised otherwise: a run that never reaches a REFUSE cannot show that a REFUSE stops it, and
// a gate that is fatal in neither direction is indistinguishable from one that always passes.
func azureRedisPreflightOutcome(res preflightResult, sku, source string) (fatal bool, msg string) {
	msg = fmt.Sprintf("azure Managed Redis capacity preflight [%s]: %s (sku %q resolved from %s; probe: %s)",
		res.Verdict, res.Detail, sku, source, res.Probe)
	// ONLY a REFUSE can be fatal, and only under REQUIRE. An UNKNOWN is a probe that did not
	// answer: it must never red a nightly, or the first `az` hiccup takes the whole cloud down.
	return res.Verdict == preflightRefuse && t2RequireIsHard(), msg
}
