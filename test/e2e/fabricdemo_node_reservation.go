// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

import (
	"fmt"
	"math"
)

// WHAT A NODE CAN ACTUALLY SCHEDULE, NOT WHAT IT SAYS ON THE SPEC SHEET (#845).
//
// t2RequireFabricDemoNodeShape used to compare the demo floor against NOMINAL capacity
// (node_size.vcpu × node_desired_size). gcp fabric-demo run 36648775773 passed that guard on
// e2-standard-4 ×2 = 8 vCPU against a 6.9 vCPU floor, placed dev-1 Healthy, and then left the
// staging tier Degraded after a successful sync. But the scheduler never sees 8 vCPU: each node
// first loses the kubelet's reservation (the cloud's documented allocatable formula), and then the
// DaemonSets the cloud itself puts on every node request their share of what is left. The guard was
// answering "how big are the machines" when the run asks "how much can be placed".
//
// So each node's capacity is now reduced by a per-node reservation made of two parts, kept apart
// because they have different standing:
//
//   - kubeletReserved — DERIVED from the provider's own published formula (cited per function), plus
//     the kubelet's hard eviction threshold. These are arithmetic, not estimates.
//   - daemonSet — the system DaemonSets' requests. Only GKE's is MEASURED (see gkeDaemonSetCPU);
//     the others are stated ALLOWANCES, each naming what it covers. They are the numbers a scheduling
//     dump (argo_app_sched_diag.go: per-node FREE cpu) should replace when a run prints one.
//
// Memory is converted MiB→GB as MiB/1024, i.e. GiB read as GB. The catalog's memory_gb is a GiB
// figure on every cloud here (e2-standard-4 "16", t3.xlarge "16"), so this is the same unit, and any
// rounding makes the reservation larger, never smaller.

// kubeletEvictionHardMiB is the kubelet's default `evictionHard: memory.available<100Mi`, which every
// provider below keeps (GKE and AKS ≥1.29 document it explicitly; EKS/Bottlerocket, ACK and Talos
// inherit the upstream kubelet default). It is withheld from allocatable like a reservation.
const kubeletEvictionHardMiB = 100

// fabricDemoMaxPodsAssumed is the max-pods figure fed to the per-pod memory formulas (EKS,
// Bottlerocket, ACK, AKS). 110 is the upstream kubelet default and the value the AKS module pins
// (infra/templates/project/azure/modules/aks/main.tf: `max_pods = 110`). On EKS the real figure is
// the ENI limit (58 for a t3.xlarge without prefix delegation), so 110 over-reserves there — the safe
// direction for a guard whose failure mode is an 11-hour Pending run.
const fabricDemoMaxPodsAssumed = 110

// nodeReservation is one node's withheld capacity, with its two parts kept separable for messages.
type nodeReservation struct {
	KubeletVCPU, KubeletMemGB     float64 // the provider's documented allocatable formula + eviction
	DaemonSetVCPU, DaemonSetMemGB float64 // system DaemonSets' requests (measured or a stated allowance)
	Model                         string  // the distribution the formula belongs to, for the message
}

// VCPU is the total per-node CPU reservation.
func (r nodeReservation) VCPU() float64 { return r.KubeletVCPU + r.DaemonSetVCPU }

// MemGB is the total per-node memory reservation.
func (r nodeReservation) MemGB() float64 { return r.KubeletMemGB + r.DaemonSetMemGB }

// tieredKubeReservedCPU is the CPU kube-reserved formula GKE, EKS (and Bottlerocket) and ACK all
// publish, in vCPU:
//
//	"6% of the first core, 1% of the next core (up to 2 cores), 0.5% of the next 2 cores (up to 4
//	cores), 0.25% of any cores greater than 4 cores"
//
// Sources: GKE https://docs.cloud.google.com/kubernetes-engine/docs/concepts/plan-node-sizes ;
// Bottlerocket (the EKS template's default AMI, `eks_ami_type = BOTTLEROCKET_x86_64`) kube_cpu_helper
// in bottlerocket-core-kit sources/api/schnauzer/src/helpers/mod.rs, "taken from EKS' calculations"
// (its own test pins 4 cores → 80m); ACK https://www.alibabacloud.com/help/en/ack/ack-managed-and-ack-dedicated/user-guide/resource-reservation-policy
// (1.28+). packages/core/catalog/nodefit.go gkeAllocatableCPUMilli is the same formula, verified there
// against a measured node.
func tieredKubeReservedCPU(vcpu float64) float64 {
	remaining := vcpu
	reserved := 0.0
	for _, tier := range []struct{ upTo, rate float64 }{{1, 0.06}, {1, 0.01}, {2, 0.005}, {math.Inf(1), 0.0025}} {
		n := math.Min(remaining, tier.upTo)
		if n <= 0 {
			break
		}
		reserved += n * tier.rate
		remaining -= n
	}
	return reserved
}

// gkeKubeReservedMemGB is GKE's memory kube-reserved for node pools on 1.36 or earlier:
//
//	"25% of the first 4 GiB of memory; 20% of the next 4 GiB of memory (up to 8 GiB); 10% of the next
//	8 GiB of memory (up to 16 GiB); 6% of the next 112 GiB of memory (up to 128 GiB); 2% of any memory
//	greater than 128 GiB" (255 MiB below 1 GiB)
//
// 1.37+ is `Min(EarlierMemoryReservation, 15 MiB × MaxPodsPerNode + BaseOverhead)`, so the earlier
// formula is an UPPER bound on every version — which is why it is the one used, without having to
// know the node pool's version (the reason nodefit.go declined to model memory at all).
func gkeKubeReservedMemGB(memGB float64) float64 {
	if memGB < 1 {
		return 255.0 / 1024
	}
	remaining := memGB
	reserved := 0.0
	for _, tier := range []struct{ upTo, rate float64 }{{4, 0.25}, {4, 0.20}, {8, 0.10}, {112, 0.06}, {math.Inf(1), 0.02}} {
		n := math.Min(remaining, tier.upTo)
		if n <= 0 {
			break
		}
		reserved += n * tier.rate
		remaining -= n
	}
	return reserved
}

// aksKubeReservedCPUMilli is AKS's published CPU table (https://learn.microsoft.com/en-us/azure/aks/node-resource-reservations):
//
//	cores:  1   2   4   8   16  32  64
//	milli:  60  100 140 180 260 420 740
//
// A core count between rows takes the NEXT row up, so an unlisted size over-reserves rather than under.
func aksKubeReservedCPUMilli(vcpu float64) float64 {
	table := []struct{ cores, milli float64 }{{1, 60}, {2, 100}, {4, 140}, {8, 180}, {16, 260}, {32, 420}, {64, 740}}
	for _, row := range table {
		if vcpu <= row.cores {
			return row.milli
		}
	}
	return table[len(table)-1].milli
}

// perPodMemReservedGB is the `min(perPodMiB × maxPods + baseMiB, capFraction × memory)` family of
// memory formulas, in GB. capFraction 0 means uncapped.
func perPodMemReservedGB(memGB, perPodMiB, baseMiB, capFraction float64) float64 {
	r := (perPodMiB*fabricDemoMaxPodsAssumed + baseMiB) / 1024
	if capFraction > 0 {
		r = math.Min(r, capFraction*memGB)
	}
	return r
}

// The DaemonSet half.
//
// gkeDaemonSetCPU is MEASURED, not estimated: e2e run 35499891484 (2026-09-20), GKE Standard with
// this template's cluster options (Calico network policy, Workload Identity, managed Prometheus), had
// an autoscaler-added node carrying nothing but GKE's own system pods refuse a 100m request out of
// 940m allocatable — so those pods request more than 840m per node (recorded in
// packages/core/catalog/nodefit.go). 0.85 is that lower bound rounded up to the next 50m. It is a
// FLOOR on the true figure, which makes the gcp model optimistic if anything.
//
// Every other figure is an ALLOWANCE — stated, not measured — and names what it covers:
//   - aws (EKS + Bottlerocket): aws-node (VPC CNI), kube-proxy, ebs-csi-node (the template installs
//     aws-ebs-csi-driver). The template turns on no network-policy engine.
//   - azure (AKS): kube-proxy, calico-node (the template sets `network_policy = "calico"`),
//     cloud-node-manager, azure-ip-masq-agent, azure-cns, csi-azuredisk-node, csi-azurefile-node.
//   - hetzner (Talos): cilium agent, hcloud-csi node plugin.
//   - alibaba (ACK): the CNI (terway/flannel), kube-proxy, csi-plugin, the log agent.
const (
	gkeDaemonSetCPU   = 0.85
	gkeDaemonSetMemGB = 0.6
)

// fabricDemoNodeReservationFor returns one node's reservation on provider for a node of vcpu/memGB.
// ok=false for a provider with no model: the guard refuses those rather than assuming nominal is
// schedulable, which is the very mistake this file corrects.
func fabricDemoNodeReservationFor(provider string, vcpu, memGB float64) (nodeReservation, bool) {
	evict := kubeletEvictionHardMiB / 1024.0
	switch provider {
	case "gcp":
		return nodeReservation{
			Model:         "GKE",
			KubeletVCPU:   tieredKubeReservedCPU(vcpu),
			KubeletMemGB:  gkeKubeReservedMemGB(memGB) + evict,
			DaemonSetVCPU: gkeDaemonSetCPU, DaemonSetMemGB: gkeDaemonSetMemGB,
		}, true
	case "aws":
		// Bottlerocket kube_reserve_memory: "memory_to_reserve = max_num_pods * 11 + 255" (MiB), uncapped.
		return nodeReservation{
			Model:         "EKS/Bottlerocket",
			KubeletVCPU:   tieredKubeReservedCPU(vcpu),
			KubeletMemGB:  perPodMemReservedGB(memGB, 11, 255, 0) + evict,
			DaemonSetVCPU: 0.2, DaemonSetMemGB: 0.3,
		}, true
	case "azure":
		// AKS ≥1.29: "the lesser value of: 20 MB * Max Pods supported on the Node + 50 MB or 25% of the
		// total system memory", plus memory.available<100Mi.
		return nodeReservation{
			Model:         "AKS",
			KubeletVCPU:   aksKubeReservedCPUMilli(vcpu) / 1000,
			KubeletMemGB:  perPodMemReservedGB(memGB, 20, 50, 0.25) + evict,
			DaemonSetVCPU: 0.6, DaemonSetMemGB: 0.6,
		}, true
	case "hetzner":
		// Talos sets systemReserved only: KubeletSystemReservedCPU = "50m",
		// KubeletSystemReservedMemoryWorker = "384Mi" (siderolabs/talos
		// pkg/machinery/constants/constants.go, applied in
		// internal/app/machined/pkg/controllers/k8s/kubelet_spec.go). node_desired_size maps to
		// worker_count (packages/core/cloud/hetzner_provider.go), so these are workers.
		return nodeReservation{
			Model:         "Talos",
			KubeletVCPU:   0.05,
			KubeletMemGB:  384.0/1024 + evict,
			DaemonSetVCPU: 0.3, DaemonSetMemGB: 0.4,
		}, true
	case "alibaba":
		// ACK 1.28+: "min(11 × ($max_num_pods) + 255, 25% × node memory)" (MiB).
		return nodeReservation{
			Model:         "ACK",
			KubeletVCPU:   tieredKubeReservedCPU(vcpu),
			KubeletMemGB:  perPodMemReservedGB(memGB, 11, 255, 0.25) + evict,
			DaemonSetVCPU: 0.4, DaemonSetMemGB: 0.5,
		}, true
	}
	return nodeReservation{}, false
}

// fabricDemoSchedulable returns what the pool can actually schedule: nodes × (nominal − reservation),
// never negative per node.
func fabricDemoSchedulable(r nodeReservation, nodes, vcpu, memGB float64) (schedVCPU, schedMemGB float64) {
	return nodes * math.Max(0, vcpu-r.VCPU()), nodes * math.Max(0, memGB-r.MemGB())
}

// fabricDemoRegionalVCPUQuota is the total regional vCPU a cloud's e2e subscription can hold, where
// that is the binding constraint. Azure's is 10 (Total Regional; ESv3 10, DSv3 10, DSv5 0 — #5075,
// #5121), and the AKS module renders ONE pool (see heavyMinVCPUByCloud), so desired × per-node vCPU is
// the whole bill against it. A shape over it fails on quota after apply starts; the guard refuses it
// first. When a cloud here cannot clear the floor INSIDE its quota the guard's refusal says so —
// TestFabricDemoAzureHasNoInQuotaShape enumerates the catalog to keep that sentence true.
var fabricDemoRegionalVCPUQuota = map[string]float64{"azure": 10}

// String renders the reservation for a message.
func (r nodeReservation) String() string {
	return fmt.Sprintf("%s reserves %.2f vCPU / %.2f GB per node (kubelet %.2f/%.2f + system DaemonSets %.2f/%.2f)",
		r.Model, r.VCPU(), r.MemGB(), r.KubeletVCPU, r.KubeletMemGB, r.DaemonSetVCPU, r.DaemonSetMemGB)
}
