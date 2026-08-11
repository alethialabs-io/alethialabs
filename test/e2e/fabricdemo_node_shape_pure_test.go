// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// FREE, every-PR proof of the fabric-demo node-shape guard — NO build tag, NO cloud.
//
// The sibling of maxconfig_node_shape_pure_test.go, for the scenario that had neither a guard nor a
// shape. #845's demo places the enterprise-demo overlays once per tier AND once more inside the
// vcluster (whose pods schedule on the host), but e2e-nightly.yml swapped in a bigger pool only on
// FULL-BAR — and t2RequireMaxConfigNodeShape is a no-op unless both heavy dimensions are on. So
// ALETHIA_E2E_FABRIC_DEMO alone ran a ~4.9 vCPU / 4.1 GiB workload on the cheapest floor shape (one
// e2-small, 2 GiB, on gcp). The pods sit Pending, nothing recovers them, and the run burns the whole
// 165-minute cap on every cloud before reporting: ~11 hours of billed cluster time to learn a node
// size, on a MAIN-GATED workflow where each attempt costs a day.
//
// So: the guard refuses in seconds, and every shipped demo profile is proven here — it exists, clears
// the floor its own tier count implies, names an instance type the product catalog actually offers,
// and survives the provider's own ValidateConfig after the key-by-key merge the real run performs.
package e2e

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/catalog"
	corecloud "github.com/alethialabs-io/alethialabs/packages/core/cloud"
	coretypes "github.com/alethialabs-io/alethialabs/packages/core/types"
)

// enableFabricDemo turns on the scenario + REQUIRE (hard-fail mode).
func enableFabricDemo(t *testing.T) {
	t.Helper()
	t.Setenv("ALETHIA_E2E_FABRIC_DEMO", "1")
	t.Setenv("ALETHIA_E2E_T2_REQUIRE", "1")
}

// demoTierCount is the shipped default: fabricDemoDefaultOverlays is "dev=boutique-dev,staging=boutique-staging".
const demoTierCount = 2

func TestFabricDemoNodeShapeGuard(t *testing.T) {
	t.Run("noop when the demo is off", func(t *testing.T) {
		t.Setenv("ALETHIA_E2E_FABRIC_DEMO", "")
		snap := map[string]any{"cluster": map[string]any{"node_desired_size": float64(1)}}
		if fatal, msg := t2RequireFabricDemoNodeShape("gcp", snap, demoTierCount); msg != "" || fatal {
			t.Fatalf("guard tripped with the demo off: fatal=%v msg=%q", fatal, msg)
		}
	})

	t.Run("noop on a falsey non-empty value", func(t *testing.T) {
		// The job/step caps key on `!= ''`, the harness on t2Truthy. A `0` must not enable the guard,
		// or a maintainer who parks the variable at 0 gets a red for a scenario that will not run.
		t.Setenv("ALETHIA_E2E_FABRIC_DEMO", "0")
		t.Setenv("ALETHIA_E2E_T2_REQUIRE", "1")
		snap := map[string]any{"cluster": map[string]any{"node_desired_size": float64(1)}}
		if fatal, msg := t2RequireFabricDemoNodeShape("gcp", snap, demoTierCount); msg != "" || fatal {
			t.Fatalf("guard tripped on E2E_FABRIC_DEMO=0: fatal=%v msg=%q", fatal, msg)
		}
	})

	t.Run("hard-fails on the nightly's actual floor shape", func(t *testing.T) {
		// THE REGRESSION. This is verbatim the gcp floor shape from e2e-nightly.yml's `Compute cluster
		// shape` step — the shape the demo really ran on. It declares no node_size, so before this
		// guard existed nothing looked at capacity at all.
		enableFabricDemo(t)
		var cluster map[string]any
		if err := json.Unmarshal([]byte(`{"instance_types":["e2-small"],"node_min_size":1,"node_max_size":2,"node_desired_size":1,"node_disk_size_gb":20}`), &cluster); err != nil {
			t.Fatalf("decode the floor shape: %v", err)
		}
		fatal, msg := t2RequireFabricDemoNodeShape("gcp", map[string]any{"cluster": cluster}, demoTierCount)
		if !fatal || msg == "" {
			t.Fatalf("the gcp FLOOR shape must be refused for a fabric-demo run — this is the ~11-hour trap; got fatal=%v msg=%q", fatal, msg)
		}
	})

	t.Run("hard-fails when the shape declares no capacity", func(t *testing.T) {
		// Enough nodes, but no node_size: degrading to a node count would make the guard toothless,
		// which is the failure mode t2_providers.go exists to avoid.
		enableFabricDemo(t)
		snap := map[string]any{"cluster": map[string]any{
			"node_desired_size": float64(3), "instance_types": []any{"e2-small"},
		}}
		fatal, msg := t2RequireFabricDemoNodeShape("gcp", snap, demoTierCount)
		if !fatal || msg == "" {
			t.Fatalf("expected hard fail with no node_size, got fatal=%v msg=%q", fatal, msg)
		}
	})

	t.Run("hard-fails on too-few nodes", func(t *testing.T) {
		enableFabricDemo(t)
		snap := map[string]any{"cluster": map[string]any{
			"node_desired_size": float64(1),
			"node_size":         map[string]any{"vcpu": float64(16), "memory_gb": float64(64)},
		}}
		fatal, msg := t2RequireFabricDemoNodeShape("aws", snap, demoTierCount)
		if !fatal || msg == "" {
			t.Fatalf("expected hard fail on 1 node even with ample capacity, got fatal=%v msg=%q", fatal, msg)
		}
	})

	t.Run("hard-fails on insufficient total capacity", func(t *testing.T) {
		enableFabricDemo(t)
		// 2 nodes clears the node floor; 2 vCPU × 2 = 4 vCPU is under the 2-tier floor (6.9).
		snap := map[string]any{"cluster": map[string]any{
			"node_desired_size": float64(2),
			"node_size":         map[string]any{"vcpu": float64(2), "memory_gb": float64(8)},
		}}
		fatal, msg := t2RequireFabricDemoNodeShape("aws", snap, demoTierCount)
		if !fatal || msg == "" {
			t.Fatalf("expected hard fail on 4 total vCPU, got fatal=%v msg=%q", fatal, msg)
		}
	})

	t.Run("the floor scales with the tier count", func(t *testing.T) {
		// A shape that is fine for 2 tiers must be refused when a maintainer adds tiers via
		// ALETHIA_E2E_FABRIC_DEMO_OVERLAYS — the whole reason the floor is a function and not a constant.
		enableFabricDemo(t)
		snap := map[string]any{"cluster": map[string]any{
			"node_desired_size": float64(2),
			"node_size":         map[string]any{"vcpu": float64(4), "memory_gb": float64(16)},
		}}
		if fatal, msg := t2RequireFabricDemoNodeShape("aws", snap, demoTierCount); msg != "" {
			t.Fatalf("8 vCPU / 32 GB must satisfy the 2-tier floor: fatal=%v msg=%q", fatal, msg)
		}
		if fatal, _ := t2RequireFabricDemoNodeShape("aws", snap, 6); !fatal {
			t.Fatal("8 vCPU / 32 GB must NOT satisfy a 6-tier floor — the floor has to scale with the tiers")
		}
	})

	t.Run("floor arithmetic is monotonic in the tier count", func(t *testing.T) {
		prevV, prevM := fabricDemoNodeFloor(1)
		for tiers := 2; tiers <= 8; tiers++ {
			v, m := fabricDemoNodeFloor(tiers)
			if v <= prevV || m <= prevM {
				t.Fatalf("floor must strictly increase with tiers: %d→(%.1f,%.1f) not > %d→(%.1f,%.1f)", tiers, v, m, tiers-1, prevV, prevM)
			}
			prevV, prevM = v, m
		}
	})
}

// TestDemoProfilesSatisfyTheFabricDemoGuard is the pairing the workflow depends on: the `Compute
// cluster shape` step hard-errors when fixtures/cluster_json.demo.<cloud>.json is absent, and this
// asserts the ones that DO exist actually clear the floor. Named in that step's error message, so a
// maintainer adding a cloud is told which test covers them.
func TestDemoProfilesSatisfyTheFabricDemoGuard(t *testing.T) {
	for _, cloud := range maxConfigClouds() {
		t.Run(cloud, func(t *testing.T) {
			enableFabricDemo(t)
			snap := map[string]any{"cluster": loadDemoProfile(t, cloud)}
			if fatal, msg := t2RequireFabricDemoNodeShape(cloud, snap, demoTierCount); msg != "" {
				t.Fatalf("the shipped %s demo profile must satisfy the guard, but it did not: fatal=%v msg=%q", cloud, fatal, msg)
			}
		})
	}
}

// TestDemoProfilesDeclareACatalogInstance mirrors TestHeavyProfilesDeclareACatalogInstance, and for
// the same reason: node_size never reaches a provider, so it is self-attested unless something
// compares it to the instance type sitting beside it. A fixture could otherwise claim 4 vCPU / 16 GB
// next to an e2-small and pass its own guard.
//
// It also catches a real trap on Azure. The floor shape pins Standard_D2s_v3 and the guard's own
// comment discusses Standard_D4s_v5 — but the CATALOG offers neither D2s_v3 nor D4s_v3, so a demo
// fixture built by copying the floor shape's SKU would assert a machine the console can never emit.
func TestDemoProfilesDeclareACatalogInstance(t *testing.T) {
	cat := catalog.MustLoad()
	for _, cloud := range maxConfigClouds() {
		t.Run(cloud, func(t *testing.T) {
			profile := loadDemoProfile(t, cloud)

			types, ok := profile["instance_types"].([]any)
			if !ok || len(types) == 0 {
				t.Fatal("the demo profile must pin an explicit instance_types — without it the guard cannot check capacity")
			}
			want, ok := types[0].(string)
			if !ok || want == "" {
				t.Fatalf("instance_types[0] is not a machine type: %#v", types[0])
			}

			compute, ok := cat.Compute[cloud]
			if !ok || len(compute.Instances) == 0 {
				t.Fatalf("catalog has no compute inventory for %s — the fixture cannot be checked against the product", cloud)
			}
			var found *catalog.Instance
			for i := range compute.Instances {
				if compute.Instances[i].Value == want {
					found = &compute.Instances[i]
					break
				}
			}
			if found == nil {
				t.Fatalf("demo profile pins %q, which packages/core/catalog/catalog.json does not offer for %s — "+
					"the demo would prove a node shape the console can never emit", want, cloud)
			}

			ns, ok := profile["node_size"].(map[string]any)
			if !ok {
				t.Fatal("the demo profile must declare node_size — it is the only capacity signal the guard can enforce")
			}
			vcpu, _ := t2Num(ns["vcpu"])
			mem, _ := t2Num(ns["memory_gb"])
			if vcpu != found.VCPU || mem != found.MemoryGB {
				t.Errorf("demo profile declares node_size %.0fvCPU/%.0fGB but %q is %.0fvCPU/%.0fGB in the catalog — "+
					"node_size is what the floor is enforced against, so a wrong pair makes the guard assert a machine that will not exist",
					vcpu, mem, want, found.VCPU, found.MemoryGB)
			}
		})
	}
}

// TestDemoProfilesSurviveTheRealConfigValidator judges the profile the way it is USED, not in
// isolation: ALETHIA_E2E_CLUSTER_JSON is merged KEY BY KEY (t2MergeClusterJSON), so a profile silent
// about a key inherits whatever was there. The heavy profiles nearly shipped a min=6/max=5 that
// validateNodeSizing refuses outright, which is why this test exists for them; the demo profiles get
// it too, against BOTH bases they can land on — max-config's block (a full-bar run also carrying the
// demo) and a bare block (the ordinary floor run, which is the demo's real habitat).
func TestDemoProfilesSurviveTheRealConfigValidator(t *testing.T) {
	for _, provider := range maxConfigClouds() {
		for _, base := range []string{"maxconfig", "bare"} {
			t.Run(provider+"/"+base, func(t *testing.T) {
				snapshot := map[string]any{
					"id": "e2e-audit", "project_name": "fabricdemo", "environment_stage": "dev",
					"provider": provider, "region": "eu-central-1", "addons": []any{},
				}
				if base == "maxconfig" {
					if err := MaxConfigSnapshot(snapshot, provider); err != nil {
						t.Fatalf("MaxConfigSnapshot(%s): %v", provider, err)
					}
				}
				raw, err := json.Marshal(loadDemoProfile(t, provider))
				if err != nil {
					t.Fatalf("re-marshal demo profile: %v", err)
				}
				t.Setenv("ALETHIA_E2E_CLUSTER_JSON", string(raw))
				if err := t2MergeClusterJSON(snapshot); err != nil {
					t.Fatalf("merge demo profile: %v", err)
				}

				encoded, err := json.Marshal(snapshot)
				if err != nil {
					t.Fatalf("marshal snapshot: %v", err)
				}
				var pc coretypes.ProjectConfig
				if err := json.Unmarshal(encoded, &pc); err != nil {
					t.Fatalf("decode snapshot into ProjectConfig: %v", err)
				}
				pc.Provider = coretypes.CloudProvider(provider)

				cp, err := corecloud.NewCloudProvider(provider)
				if err != nil {
					t.Fatalf("no cloud provider %q: %v", provider, err)
				}
				if err := cp.ValidateConfig(&pc); err != nil {
					t.Errorf("the %s fabric-demo snapshot (%s base + demo profile) is REFUSED by the provider's own "+
						"ValidateConfig: %v\nmerged cluster block: %v\nthe profile is merged KEY BY KEY, so it must "+
						"state every key whose base value it contradicts — node_max_size is the one that bites",
						provider, base, err, snapshot["cluster"])
				}
			})
		}
	}
}

// loadDemoProfile reads fixtures/cluster_json.demo.<cloud>.json as the cluster block.
func loadDemoProfile(t *testing.T, cloud string) map[string]any {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate the e2e package directory")
	}
	path := filepath.Join(filepath.Dir(thisFile), "fixtures", "cluster_json.demo."+cloud+".json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read demo profile fixture: %v — a fabric-demo run on this cloud hard-errors in the workflow without it", err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("parse demo profile fixture: %v", err)
	}
	return m
}
