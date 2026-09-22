// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package catalog

import (
	"fmt"
	"sort"
	"strings"
)

// Can the node shape a user picked actually RUN what the product installs on it?
//
// Nothing asked this before #3855. Every pre-spend check the product and the e2e harness carry
// asks a different question — "is this a machine type that exists here" (the capacity preflight),
// "is min <= desired <= max" (validateNodeSizing), "is the disk above the template's floor". All of
// those pass on a shape that provisions a perfectly healthy EMPTY cluster and then cannot schedule
// the control plane onto it. That is not a hypothetical: it is what the product's own DEFAULT GCP
// machine type did, and this file exists so that fact is computable before anyone spends money.
//
// ── The measurement ──
//
// e2e nightly run 35499891484 (2026-09-20), gcp floor, GKE 1.35 Standard, 1 x `e2-medium`,
// europe-west3-a, with the three cluster options the product's own template turns on — Calico
// network policy, Workload Identity (GKE_METADATA) and managed Prometheus. Both nodes reported:
//
//	allocatable cpu: 940m       allocatable memory: 2866840Ki
//
// On that cluster:
//
//	argo-cd-argocd-repo-server   Pending   0/1 nodes are available: 1 Insufficient cpu
//	                                       0/2 nodes are available: 2 Insufficient cpu
//	                                       NotTriggerScaleUp: 1 max node group size reached
//	calico-typha-6bd76746-fphst  Pending   (21m, never scheduled)
//	calico-typha-6bd76746-t7jzz  Pending   (19m, never scheduled)
//	calico-node-pl296            0/1 Running
//	calico-node-qhn8p            0/1 Running
//
// Two things follow, and the second is the more serious one.
//
// FIRST: repo-server requests 100m (argocd.RepoServerCPURequest). The SECOND node in that list was
// added by the autoscaler and carried nothing but GKE's own system pods, and a 100m request did not
// fit on it either. So GKE's per-node system requests exceed 840m of the 940m allocatable — LESS
// THAN 100m of that node is schedulable at all. This is not a measurement of ArgoCD's appetite; it
// is a measurement of how little of the node is left.
//
// SECOND: `calico-typha` is not ours. It is the control plane of the network-policy addon that
// `infra/templates/project/gcp/modules/gke/main.tf` turns on, and whose comment names it as the
// mechanism behind namespace-placement tenant isolation (#1012). With zero Typha replicas
// schedulable, Felix on both nodes logged
//
//	[ERROR] felix/discovery.go 228: Didn't find any ready Typha instances.
//	[FATAL] status-reporter: Typha discovery enabled but discovery failed.
//
// and `calico-node` never became Ready. NetworkPolicy was not being enforced on that cluster, and
// nothing said so: the apply succeeded, the nodes were Ready, `kubectl get nodes` was clean. The
// shape cannot run the addons GKE ITSELF installs, before Alethia installs anything.
//
// ── What this file therefore refuses, and what it deliberately does not ──
//
// It refuses a GKE node whose allocatable CPU is at or below the 940m that was measured. It does
// NOT model a required working set, because nobody has measured one — the amount of headroom the
// control plane needs is still unknown, and inventing a number here would be the same mistake this
// file is fixing. The only claim is the measured one: 940m is not enough.
//
// The bound's exact value is not load-bearing, and that is worth stating because it looks
// suspiciously precise. GKE's published reservation (see gkeAllocatableCPUMilli) means every GCP
// machine type lands on one of a few rungs, and there is no rung between 940m and 1930m: a
// shared-core E2 and a 1-vCPU N1 both give 940m, and the next thing GCP sells gives 1930m. Any
// threshold in that gap classifies every machine type identically. The measured value is used
// because it is the one number that was actually observed, not because the boundary is fine-tuned.
//
// ── CPU only, and GKE only ──
//
// MEMORY is not modelled. #4179's memory half worked — 2866840Ki was ample on the failing run, and
// the failure was on the other axis — and GKE's memory reservation formula CHANGED at node-pool
// version 1.37 (tiered percentages before, `Min(earlier, 15 MiB * maxPods + overhead)` after), so a
// memory model would have to know the node pool's version to be right. A guard that is right about
// the axis that was measured beats one that is also confidently wrong about the axis that was not.
//
// AWS and AZURE return FitUnknown, and that hole is deliberate rather than a gap waiting to be
// filled. What makes 940m insufficient is not arithmetic, it is the specific pile of DaemonSets GKE
// places on every node (fluentbit-gke, gke-metadata-server, gke-metrics-agent, netd, node-local-dns,
// ip-masq-agent, pdcsi-node, calico-node, kube-proxy) plus kube-dns and konnectivity. EKS and AKS
// place a different and much smaller set, and no shape on either has ever been measured to fail this
// way — the two floors that pass the same ArgoCD assertion nightly are `t3.large` and
// `Standard_D2s_v3`. Claiming a number for them would be a sentence nothing measured.

// FitVerdict is the outcome of a control-plane fit check. There are exactly three, and the third
// is not a failure: a shape this file cannot reason about must proceed, because the alternative is
// refusing a customer's machine type on no evidence.
type FitVerdict string

const (
	// FitOK means the shape's allocatable CPU is above what was measured to be insufficient.
	// It is NOT a promise that the control plane converges — see the file comment.
	FitOK FitVerdict = "OK"
	// FitTooSmall means the shape is at or below the measured-insufficient allocatable CPU.
	FitTooSmall FitVerdict = "TOO_SMALL"
	// FitUnknown means this file has no model for the shape: another cloud, or a machine type
	// the catalog does not carry. It never blocks anything.
	FitUnknown FitVerdict = "UNKNOWN"
)

// gkeMeasuredInsufficientCPUMilli is the allocatable CPU of the node shape that was MEASURED to be
// unable to host the control plane (run 35499891484 — see the file comment). A shape at or below it
// is refused; a shape above it is not vouched for, only un-refuted.
const gkeMeasuredInsufficientCPUMilli = 940

// gkeSharedCoreReservedCPUMilli is the flat CPU reservation GKE applies to shared-core E2 machine
// types, from GKE's own "Plan node sizes" reference: "For shared-core E2 machine types, GKE still
// reserves a total of 1060 millicores." It is why `e2-medium` (2 vCPU on paper, the same as an AWS
// `t3.medium`) delivers 940m where `t3.medium` delivers ~1930m — the single most surprising fact in
// this whole area, and the reason the defect was invisible from the machine type's spec sheet.
const gkeSharedCoreReservedCPUMilli = 1060

// gcpSharedCoreTypes matches the machine types GCP documents as shared-core. It is a RULE rather
// than a list of the catalog's current members, so a machine type added to the catalog tomorrow is
// classified without anyone remembering to come back here.
//
// If GCP ships a shared-core family this does not name, the miss is in the fail-open direction: the
// type is treated as dedicated, gets a larger computed allocatable, and is not refused. That is the
// correct direction for a guard whose evidence is one measured configuration.
var gcpSharedCoreTypes = []string{"e2-micro", "e2-small", "e2-medium", "f1-micro", "g1-small"}

// NodeFit is one shape's answer. Detail is ALWAYS non-empty, on every verdict, for the same reason
// the e2e capacity preflight's is: a check that says nothing when it passes cannot be audited from
// a log, and the PROCEED line is the one a reader needs when a later failure makes them ask what
// was checked.
type NodeFit struct {
	Provider     string     `json:"provider"`
	InstanceType string     `json:"instance_type"`
	Verdict      FitVerdict `json:"verdict"`
	// AllocatableCPUMilli is the computed per-node schedulable CPU, or 0 when Verdict is
	// FitUnknown and nothing could be computed.
	AllocatableCPUMilli int `json:"allocatable_cpu_milli"`
	// Detail says what was computed and why it lands where it does.
	Detail string `json:"detail"`
	// Suggestion names the cheapest catalog machine type that clears the bound, and is empty on
	// any verdict but FitTooSmall. A refusal that does not name the way out is half a refusal.
	Suggestion string `json:"suggestion"`
}

// isGCPSharedCore reports whether a GCP machine type pays GKE's flat shared-core reservation.
func isGCPSharedCore(instanceType string) bool {
	t := strings.ToLower(strings.TrimSpace(instanceType))
	for _, s := range gcpSharedCoreTypes {
		if t == s {
			return true
		}
	}
	return false
}

// gkeAllocatableCPUMilli computes a GKE Standard node's allocatable CPU in millicores, from GKE's
// published reservation formula: "6% of the first core, 1% of the next core (up to 2 cores), 0.5%
// of the next 2 cores (up to 4 cores), 0.25% of any cores greater than 4 cores", with shared-core
// E2 types instead reserving a flat 1060 millicores.
//
// Verified against the only node this repo has ever measured: `e2-medium`, 2 vCPU, shared-core →
// 2000 - 1060 = 940m, and run 35499891484 reported `allocatable cpu: 940m` on both of its nodes.
func gkeAllocatableCPUMilli(vcpu float64, sharedCore bool) int {
	capacity := int(vcpu * 1000)
	if capacity <= 0 {
		return 0
	}
	if sharedCore {
		reserved := gkeSharedCoreReservedCPUMilli
		if reserved > capacity {
			return 0
		}
		return capacity - reserved
	}

	// Tiered percentages, applied to whole millicores so the result is exact rather than a float
	// that happens to round the right way. 6% / 1% / 0.5% / 0.25% == 60 / 10 / 5 / 2.5 per 1000m.
	reservedTenths := 0 // tenths of a millicore, so the 0.25% tier stays integral
	remaining := capacity
	take := func(upTo, perThousandTenths int) {
		n := remaining
		if n > upTo {
			n = upTo
		}
		if n <= 0 {
			return
		}
		reservedTenths += n * perThousandTenths / 1000
		remaining -= n
	}
	take(1000, 600) // 6.0% of the first core
	take(1000, 100) // 1.0% of the next core
	take(2000, 50)  // 0.5% of the next two cores
	take(remaining, 25)

	// No clamp, deliberately. The steepest tier is 6%, so the reservation is always a small
	// fraction of the capacity it was computed from and the difference cannot go negative. A
	// defensive `if alloc < 0` here would be an unreachable branch that reads like a real case.
	return capacity - reservedTenths/10
}

// ControlPlaneNodeFit answers whether one machine type can host the product's control plane.
//
// It is PURE and offline — it reads the embedded catalog and nothing else — so it is free to call
// on the deploy path, in the console, and in a unit test. An unknown provider or a machine type the
// catalog does not carry returns FitUnknown rather than an error: this is a gate on the live
// provisioning path, and it must never be the reason a customer cannot deploy a shape it has simply
// never heard of.
func (c *Catalog) ControlPlaneNodeFit(provider, instanceType string) NodeFit {
	fit := NodeFit{Provider: provider, InstanceType: instanceType, Verdict: FitUnknown}

	if strings.TrimSpace(instanceType) == "" {
		fit.Detail = "no machine type is pinned, so the template's own default applies and there is nothing here to check"
		return fit
	}
	if provider != "gcp" {
		fit.Detail = fmt.Sprintf(
			"%q is not modelled: only GKE's node reservation is, because the 940m that was measured insufficient is a property of the DaemonSet set GKE places on every node, not arithmetic that carries to another cloud",
			provider)
		return fit
	}

	in, ok := c.instance(provider, instanceType)
	if !ok {
		fit.Detail = fmt.Sprintf(
			"%q is not in the catalog for %s, so its vCPU count is unknown and its allocatable CPU cannot be computed",
			instanceType, provider)
		return fit
	}

	alloc := gkeAllocatableCPUMilli(in.VCPU, isGCPSharedCore(instanceType))
	fit.AllocatableCPUMilli = alloc
	if alloc <= 0 {
		fit.Detail = fmt.Sprintf("%q declares %g vCPU, which leaves no computable allocatable CPU after GKE's reservation", instanceType, in.VCPU)
		return fit
	}

	if alloc > gkeMeasuredInsufficientCPUMilli {
		fit.Verdict = FitOK
		fit.Detail = fmt.Sprintf(
			"%q gives ~%dm allocatable CPU per GKE node, above the %dm measured unable to host the control plane (e2e run 35499891484)",
			instanceType, alloc, gkeMeasuredInsufficientCPUMilli)
		return fit
	}

	fit.Verdict = FitTooSmall
	fit.Suggestion = c.smallestFittingInstance(provider, in.Family)
	fit.Detail = fmt.Sprintf(
		"%q gives ~%dm allocatable CPU per GKE node%s. That is the shape measured in e2e run 35499891484, where GKE's own system pods left under 100m of it schedulable: argocd-repo-server stayed Pending on `Insufficient cpu`, and GKE's calico-typha never scheduled either, so calico-node never became Ready and NetworkPolicy was not enforced",
		instanceType, alloc, sharedCoreNote(instanceType))
	return fit
}

// sharedCoreNote explains a surprising number where it appears, rather than leaving the reader to
// wonder why a "2 vCPU" machine reports less than half the CPU of another "2 vCPU" machine.
func sharedCoreNote(instanceType string) string {
	if !isGCPSharedCore(instanceType) {
		return ""
	}
	return fmt.Sprintf(
		" — it is a shared-core E2 type, and GKE reserves a flat %dm on those regardless of the vCPU count on the spec sheet",
		gkeSharedCoreReservedCPUMilli)
}

// instance looks one machine type up in a provider's compute inventory.
func (c *Catalog) instance(provider, value string) (Instance, bool) {
	cp, ok := c.Compute[provider]
	if !ok {
		return Instance{}, false
	}
	for _, in := range cp.Instances {
		if in.Value == value {
			return in, true
		}
	}
	return Instance{}, false
}

// smallestFittingInstance names the cheapest catalog machine type for this provider that clears the
// bound, preferring the same family so the suggestion is a step up rather than a change of kind.
// "Cheapest" is read as fewest vCPU then least memory, because the catalog's `cost` field is a
// display string ("~$49/mo") and parsing a label to sort by it would make this depend on prose.
func (c *Catalog) smallestFittingInstance(provider, family string) string {
	// A provider with no inventory yields the zero ComputeProvider and a nil Instances slice, so the
	// loop simply finds nothing and the empty answer below is returned. An explicit `ok` check would
	// be a second, unreachable route to the same "" — this function is only ever reached after
	// `instance` has already found the shape being refused.
	var fitting []Instance
	for _, in := range c.Compute[provider].Instances {
		if gkeAllocatableCPUMilli(in.VCPU, isGCPSharedCore(in.Value)) > gkeMeasuredInsufficientCPUMilli {
			fitting = append(fitting, in)
		}
	}
	if len(fitting) == 0 {
		return ""
	}
	sort.SliceStable(fitting, func(i, j int) bool {
		if fitting[i].VCPU != fitting[j].VCPU {
			return fitting[i].VCPU < fitting[j].VCPU
		}
		return fitting[i].MemoryGB < fitting[j].MemoryGB
	})
	if family != "" {
		for _, in := range fitting {
			if in.Family == family {
				return in.Value
			}
		}
	}
	return fitting[0].Value
}
