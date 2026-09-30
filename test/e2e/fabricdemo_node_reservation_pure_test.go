// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// FREE, every-PR proof of the fabric-demo SCHEDULABLE-capacity arithmetic (#845) — NO build tag, NO
// cloud. The expected values below are taken from each provider's own published figures (cited in
// fabricdemo_node_reservation.go), NOT recomputed from the function under test.
package e2e

import (
	"math"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/catalog"
)

// near compares floats to within a millicore / a MiB-ish tolerance.
func near(a, b float64) bool { return math.Abs(a-b) < 0.0005 }

func TestTieredKubeReservedCPU(t *testing.T) {
	// Bottlerocket's own kube_cpu_helper test table (bottlerocket-core-kit helpers/mod.rs), which
	// uses exact values at these core counts: 1→60m 2→70m 3→75m 4→80m 6→85m 48→190m.
	for cores, wantMilli := range map[float64]float64{1: 60, 2: 70, 3: 75, 4: 80, 6: 85, 48: 190} {
		if got := tieredKubeReservedCPU(cores) * 1000; !near(got, wantMilli) {
			t.Errorf("tieredKubeReservedCPU(%v) = %.3fm, want %vm", cores, got, wantMilli)
		}
	}
}

func TestGKEKubeReservedMemGB(t *testing.T) {
	// GKE's tiers: 25% of 4 = 1.0; +20% of 4 = 1.8; +10% of 8 = 2.6; +6% of 16 = 3.56 at 32 GiB.
	for mem, want := range map[float64]float64{4: 1.0, 8: 1.8, 16: 2.6, 32: 3.56, 0.5: 255.0 / 1024} {
		if got := gkeKubeReservedMemGB(mem); !near(got, want) {
			t.Errorf("gkeKubeReservedMemGB(%v) = %.4f, want %.4f", mem, got, want)
		}
	}
}

func TestAKSKubeReservedCPUMilli(t *testing.T) {
	// Microsoft's table, plus the between-rows rule (next row UP) and the top row for anything larger.
	for cores, want := range map[float64]float64{1: 60, 2: 100, 3: 140, 4: 140, 8: 180, 16: 260, 64: 740, 96: 740} {
		if got := aksKubeReservedCPUMilli(cores); got != want {
			t.Errorf("aksKubeReservedCPUMilli(%v) = %v, want %v", cores, got, want)
		}
	}
}

func TestPerPodMemReservedGB(t *testing.T) {
	// AKS ≥1.29, max_pods 110 (the template's value): 20×110+50 = 2250 MB, under 25% of 16 GB.
	if got := perPodMemReservedGB(16, 20, 50, 0.25); !near(got, 2250.0/1024) {
		t.Errorf("AKS 16GB = %.4f, want %.4f", got, 2250.0/1024)
	}
	// Microsoft's worked example shape: on a 4 GB node the 25% cap (1.0) wins over 2250 MB.
	if got := perPodMemReservedGB(4, 20, 50, 0.25); !near(got, 1.0) {
		t.Errorf("AKS 4GB = %.4f, want the 25%% cap 1.0", got)
	}
	// Bottlerocket: 11×110+255 = 1465 MiB, uncapped.
	if got := perPodMemReservedGB(16, 11, 255, 0); !near(got, 1465.0/1024) {
		t.Errorf("EKS 16GB = %.4f, want %.4f", got, 1465.0/1024)
	}
}

// TestFabricDemoGuardRefusesTheShapeThatWentDegraded is the regression: gcp run 36648775773 ran the
// demo on e2-standard-4 ×2, which the NOMINAL guard passed (8 vCPU ≥ 6.9), and the staging tier went
// Degraded after a successful sync. The schedulable guard must refuse that exact shape.
func TestFabricDemoGuardRefusesTheShapeThatWentDegraded(t *testing.T) {
	enableFabricDemo(t)
	minVCPU, _ := fabricDemoNodeFloor(demoTierCount)
	if 4*2 < minVCPU {
		t.Fatalf("precondition: the nominal pool (8 vCPU) must clear the %.1f floor — that is what the old guard compared, and why it passed", minVCPU)
	}
	snap := map[string]any{"cluster": map[string]any{
		"node_desired_size": float64(2),
		"node_size":         map[string]any{"vcpu": float64(4), "memory_gb": float64(16)},
	}}
	fatal, msg := t2RequireFabricDemoNodeShape("gcp", snap, demoTierCount)
	if !fatal || !strings.Contains(msg, "SCHEDULABLE") || !strings.Contains(msg, "GKE reserves") {
		t.Fatalf("e2-standard-4 ×2 on gcp must be refused on SCHEDULABLE capacity: fatal=%v msg=%q", fatal, msg)
	}
	// The same pool with one more node — what the shipped profile now pins — clears it.
	snap["cluster"].(map[string]any)["node_desired_size"] = float64(3)
	if fatal, msg := t2RequireFabricDemoNodeShape("gcp", snap, demoTierCount); msg != "" {
		t.Fatalf("e2-standard-4 ×3 must clear the schedulable floor: fatal=%v msg=%q", fatal, msg)
	}
}

func TestFabricDemoSchedulableSubtractsPerNode(t *testing.T) {
	r := nodeReservation{KubeletVCPU: 0.08, DaemonSetVCPU: 0.85, KubeletMemGB: 2.7, DaemonSetMemGB: 0.6}
	v, m := fabricDemoSchedulable(r, 3, 4, 16)
	if !near(v, 3*(4-0.93)) || !near(m, 3*(16-3.3)) {
		t.Fatalf("schedulable = %.3f/%.3f, want %.3f/%.3f — the reservation is PER NODE", v, m, 3*(4-0.93), 3*(16-3.3))
	}
	// A reservation bigger than the node schedules nothing on it, never a negative that offsets
	// another node's real capacity.
	v, _ = fabricDemoSchedulable(nodeReservation{KubeletVCPU: 3}, 2, 2, 16)
	if v != 0 {
		t.Fatalf("an over-reserved node must contribute 0, got %.3f", v)
	}
}

func TestFabricDemoGuardRefusesOverQuota(t *testing.T) {
	enableFabricDemo(t)
	// Standard_E2s_v3 ×6 = 12 vCPU, 72 GB schedulable-ish: capacity is not the problem, the quota is.
	snap := map[string]any{"cluster": map[string]any{
		"node_desired_size": float64(6),
		"node_size":         map[string]any{"vcpu": float64(2), "memory_gb": float64(16)},
	}}
	fatal, msg := t2RequireFabricDemoNodeShape("azure", snap, demoTierCount)
	if !fatal || !strings.Contains(msg, "exceeds the e2e subscription's 10 regional vCPU quota") {
		t.Fatalf("an azure shape over the 10 vCPU quota must be refused naming it: fatal=%v msg=%q", fatal, msg)
	}
}

func TestFabricDemoGuardRefusesAnUnmodelledProvider(t *testing.T) {
	enableFabricDemo(t)
	snap := map[string]any{"cluster": map[string]any{
		"node_desired_size": float64(10),
		"node_size":         map[string]any{"vcpu": float64(64), "memory_gb": float64(256)},
	}}
	if fatal, msg := t2RequireFabricDemoNodeShape("nowhere", snap, demoTierCount); !fatal || !strings.Contains(msg, "no per-node reservation model") {
		t.Fatalf("a provider with no reservation model must be refused, not judged on nominal: fatal=%v msg=%q", fatal, msg)
	}
}

// TestFabricDemoReservationCoversEveryProvider keeps the refusal above from ever firing on a cloud
// the harness actually runs: every t2ProviderTable entry has a model.
func TestFabricDemoReservationCoversEveryProvider(t *testing.T) {
	for _, cloud := range maxConfigClouds() {
		r, ok := fabricDemoNodeReservationFor(cloud, 4, 16)
		if !ok {
			t.Errorf("%s has no fabricDemoNodeReservationFor model — its fabric demo would be refused outright", cloud)
			continue
		}
		if r.KubeletVCPU <= 0 || r.KubeletMemGB <= 0 || r.DaemonSetVCPU <= 0 || r.DaemonSetMemGB <= 0 {
			t.Errorf("%s reservation has a zero part (%+v) — a zero is 'nominal is schedulable' again", cloud, r)
		}
	}
}

// TestFabricDemoAzureHasNoInQuotaShape keeps the guard's Azure refusal TRUE. It enumerates every
// catalog Azure instance at every node count from the demo's minimum up to the 10 vCPU quota, and
// asserts none is schedulable enough. It over-approximates what is buyable (it ignores the per-FAMILY
// quotas — DSv5 is 0), so "none fits" here is a strictly stronger statement than the real one.
//
// When this fails, a shape now fits: pin it in fixtures/cluster_json.demo.azure.json, move azure out
// of TestDemoProfilesSatisfyTheFabricDemoGuard's refusedByQuota, and drop the guard's "NO catalog shape"
// sentence.
func TestFabricDemoAzureHasNoInQuotaShape(t *testing.T) {
	const cloud = "azure"
	quota := fabricDemoRegionalVCPUQuota[cloud]
	if quota <= 0 {
		t.Fatal("azure has no quota entry — this test and the guard's refusal message no longer describe the same thing")
	}
	minVCPU, minMem := fabricDemoNodeFloor(demoTierCount)
	cat := catalog.MustLoad()
	evaluated := 0
	for _, in := range cat.Compute[cloud].Instances {
		for n := fabricDemoMinNodes; float64(n)*in.VCPU <= quota; n++ {
			r, ok := fabricDemoNodeReservationFor(cloud, in.VCPU, in.MemoryGB)
			if !ok {
				t.Fatal("azure has no reservation model")
			}
			v, m := fabricDemoSchedulable(r, float64(n), in.VCPU, in.MemoryGB)
			evaluated++
			if v >= minVCPU && m >= minMem {
				t.Errorf("%s ×%d (%.0f vCPU, inside the %.0f quota) schedules %.2f vCPU / %.2f GB, clearing the %.1f/%.1f floor — azure is no longer infeasible",
					in.Value, n, float64(n)*in.VCPU, quota, v, m, minVCPU, minMem)
			}
		}
	}
	if evaluated == 0 {
		t.Fatal("no azure catalog shape fits inside the quota at all — the enumeration proved nothing")
	}
}
