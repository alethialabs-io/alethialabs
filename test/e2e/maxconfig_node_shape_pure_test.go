// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// FREE, every-PR proof of the heavy-surface node-shape guard — NO build tag, NO cloud.
// Verifies the guard fails fast on an undersized shape AND that EVERY shipped heavy profile
// (fixtures/cluster_json.heavy.<cloud>.json) exists, clears its cloud's floor, describes an
// instance type the product catalog actually offers, and — once merged onto the max-config cluster
// block the way the real run merges it — still SATISFIES the provider's own ValidateConfig. So the
// nightly's injected shape is neither silently under-provisioned, nor a shape the console could
// never emit, nor a shape the deploy refuses at plan time.
package e2e

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/catalog"
	// Aliased: this file already uses `cloud` and `types` as local identifiers (the per-cloud loop
	// variable, and the decoded instance_types list), and a shadowed package name is exactly the
	// kind of confusion a reader should not have to resolve.
	corecloud "github.com/alethialabs-io/alethialabs/packages/core/cloud"
	coretypes "github.com/alethialabs-io/alethialabs/packages/core/types"
)

// enableHeavy turns on both heavy dimensions + REQUIRE (hard-fail mode). EITHER alone also arms the
// guard now — see "each heavy dimension arms the guard on its own" below, which is the case that was
// silently unguarded.
func enableHeavy(t *testing.T) {
	t.Helper()
	t.Setenv("ALETHIA_E2E_ALL_ADDONS", "1")
	t.Setenv("ALETHIA_E2E_MAX_CONFIG", "1")
	t.Setenv("ALETHIA_E2E_T2_REQUIRE", "1")
}

func TestMaxConfigNodeShapeGuard(t *testing.T) {
	t.Run("noop when heavy surface is off", func(t *testing.T) {
		// Neither dimension on: even a tiny shape must not trip the guard.
		t.Setenv("ALETHIA_E2E_ALL_ADDONS", "")
		t.Setenv("ALETHIA_E2E_MAX_CONFIG", "")
		snap := map[string]any{"cluster": map[string]any{"node_desired_size": float64(1)}}
		if fatal, msg := t2RequireMaxConfigNodeShape("aws", snap); msg != "" || fatal {
			t.Fatalf("guard tripped when heavy surface is off: fatal=%v msg=%q", fatal, msg)
		}
	})

	t.Run("hard-fails on too-few nodes", func(t *testing.T) {
		enableHeavy(t)
		snap := map[string]any{"cluster": map[string]any{"node_desired_size": float64(1), "instance_types": []any{"m5.large"}}}
		fatal, msg := t2RequireMaxConfigNodeShape("aws", snap)
		if !fatal || msg == "" {
			t.Fatalf("expected hard fail on 1 node, got fatal=%v msg=%q", fatal, msg)
		}
	})

	t.Run("hard-fails on insufficient total capacity", func(t *testing.T) {
		enableHeavy(t)
		// 3 nodes clears the node-count floor, but 2 vCPU × 3 = 6 < heavyMinVCPU(12).
		snap := map[string]any{"cluster": map[string]any{
			"node_desired_size": float64(3),
			"node_size":         map[string]any{"vcpu": float64(2), "memory_gb": float64(8)},
		}}
		fatal, msg := t2RequireMaxConfigNodeShape("aws", snap)
		if !fatal || msg == "" {
			t.Fatalf("expected hard fail on undersized node_size, got fatal=%v msg=%q", fatal, msg)
		}
	})

	// The per-cloud vCPU floor must LOWER the bar only where it is documented, and must still enforce
	// memory. Azure is the one override (a 10-vCPU subscription quota — see heavyMinVCPUByCloud): the
	// same 6-vCPU shape that Azure accepts must still fail on AWS, or the override is really a global
	// relaxation wearing a per-cloud label.
	t.Run("per-cloud vCPU floor is scoped to the cloud that documented it", func(t *testing.T) {
		enableHeavy(t)
		azureShape := map[string]any{"cluster": map[string]any{
			"node_desired_size": float64(3),
			"node_size":         map[string]any{"vcpu": float64(2), "memory_gb": float64(16)},
		}}
		if fatal, msg := t2RequireMaxConfigNodeShape("azure", azureShape); fatal || msg != "" {
			t.Fatalf("6 vCPU / 48 GB must clear the AZURE floor (quota override): fatal=%v msg=%q", fatal, msg)
		}
		if fatal, _ := t2RequireMaxConfigNodeShape("aws", azureShape); !fatal {
			t.Fatal("the same 6-vCPU shape must still FAIL on aws — the override is per-cloud, not a global relaxation")
		}
		// Memory is NOT relaxed for anyone: 6 vCPU with 8 GB nodes is 24 GB total, under the floor.
		thin := map[string]any{"cluster": map[string]any{
			"node_desired_size": float64(3),
			"node_size":         map[string]any{"vcpu": float64(2), "memory_gb": float64(8)},
		}}
		if fatal, _ := t2RequireMaxConfigNodeShape("azure", thin); !fatal {
			t.Fatal("the azure override must lower the vCPU floor only — 24 GB total is still below heavyMinMemGB")
		}
	})

	// THE REGRESSION. The guard used to return early unless BOTH flags were on, which made it a
	// no-op on the two dimensions that need it most: `maxconfig` and `addons` each set exactly one.
	// So the workflow gave them the cheapest floor pool (it keyed the heavy shape on the `full`
	// token) and the one guard written to catch that combination said nothing — 18 charts Pending on
	// a 2-vCPU node until the 165-minute cap. Each flag on its own must trip it.
	for _, tc := range []struct{ name, env string }{
		{"max-config alone", "ALETHIA_E2E_MAX_CONFIG"},
		{"all-add-ons alone", "ALETHIA_E2E_ALL_ADDONS"},
	} {
		t.Run("each heavy dimension arms the guard on its own: "+tc.name, func(t *testing.T) {
			t.Setenv("ALETHIA_E2E_ALL_ADDONS", "")
			t.Setenv("ALETHIA_E2E_MAX_CONFIG", "")
			t.Setenv(tc.env, "1")
			t.Setenv("ALETHIA_E2E_T2_REQUIRE", "1")
			// The floor shape the workflow used to hand these dimensions: one small node.
			snap := map[string]any{"cluster": map[string]any{"node_desired_size": float64(1), "instance_types": []any{"t3.large"}}}
			fatal, msg := t2RequireMaxConfigNodeShape("aws", snap)
			if !fatal || msg == "" {
				t.Fatalf("%s must arm the node-shape guard, got fatal=%v msg=%q", tc.name, fatal, msg)
			}
			// And it must name the dimension actually requested, not a combination nobody asked for.
			if strings.Contains(msg, "max-config + all-add-ons") {
				t.Fatalf("%s reported the both-dimensions phrasing: %q", tc.name, msg)
			}
		})
	}

	// The shipped heavy profile has to satisfy the guard under a SINGLE flag too — otherwise arming
	// it on one dimension would red every maxconfig/addons run on a correctly-sized cluster.
	t.Run("the shipped heavy profile clears the floor under one flag", func(t *testing.T) {
		t.Setenv("ALETHIA_E2E_ALL_ADDONS", "1")
		t.Setenv("ALETHIA_E2E_MAX_CONFIG", "")
		t.Setenv("ALETHIA_E2E_T2_REQUIRE", "1")
		snap := map[string]any{"cluster": loadHeavyProfile(t, "aws")}
		if fatal, msg := t2RequireMaxConfigNodeShape("aws", snap); fatal || msg != "" {
			t.Fatalf("the shipped aws heavy profile must satisfy the guard under one flag: fatal=%v msg=%q", fatal, msg)
		}
	})

	t.Run("hard-fails on missing cluster block", func(t *testing.T) {
		enableHeavy(t)
		if fatal, msg := t2RequireMaxConfigNodeShape("aws", map[string]any{}); !fatal || msg == "" {
			t.Fatalf("expected hard fail on missing cluster block, got fatal=%v msg=%q", fatal, msg)
		}
	})

	t.Run("warns (not fatal) when REQUIRE is unset", func(t *testing.T) {
		t.Setenv("ALETHIA_E2E_ALL_ADDONS", "1")
		t.Setenv("ALETHIA_E2E_MAX_CONFIG", "1")
		t.Setenv("ALETHIA_E2E_T2_REQUIRE", "") // local dev: warn, don't fail
		snap := map[string]any{"cluster": map[string]any{"node_desired_size": float64(1)}}
		fatal, msg := t2RequireMaxConfigNodeShape("aws", snap)
		if fatal {
			t.Fatalf("guard must warn (not fail) off CI, got fatal=%v", fatal)
		}
		if msg == "" {
			t.Fatal("guard should still surface a warning message off CI")
		}
	})

	// EVERY cloud the harness can run must have a heavy profile that clears its own floor. The loop is
	// over the harness's provider table, not a hardcoded {aws,gcp,azure}: the workflow hard-errors on a
	// full-bar run whose fixture is absent (.github/workflows/e2e-nightly.yml, "Compute cluster shape"),
	// and the old three-cloud loop is precisely why hetzner and alibaba could reach that error at all.
	for _, cloud := range maxConfigClouds() {
		t.Run("shipped "+cloud+" heavy profile clears the floor", func(t *testing.T) {
			enableHeavy(t)
			snap := map[string]any{"cluster": loadHeavyProfile(t, cloud)}
			if fatal, msg := t2RequireMaxConfigNodeShape(cloud, snap); msg != "" || fatal {
				t.Fatalf("the shipped %s heavy profile must satisfy the guard, but it did not: fatal=%v msg=%q", cloud, fatal, msg)
			}
		})
	}
}

// TestHeavyProfilesDeclareACatalogInstance closes the gap that made the capacity floor
// self-attested. `node_size` never reaches a provider on the heavy path — resolveInstanceTypes
// returns cluster.InstanceTypes verbatim when non-empty (packages/core/cloud/resolve.go) — so its
// ONLY consumer is the guard, which trusted the hand-written {vcpu, memory_gb} pair without ever
// comparing it to the instance type sitting beside it. A fixture could claim 4 vCPU / 16 GB next to
// a t3.medium and pass.
//
// So both facts are derived from the product catalog here: the instance type must be one the console
// actually offers (the AWS fixture pinned m5.xlarge, which is NOT in catalog.json — a shape the
// harness proved and the product can never emit), and its vCPU/memory must match what the fixture
// declares.
func TestHeavyProfilesDeclareACatalogInstance(t *testing.T) {
	cat := catalog.MustLoad()
	for _, cloud := range maxConfigClouds() {
		t.Run(cloud, func(t *testing.T) {
			profile := loadHeavyProfile(t, cloud)

			types, ok := profile["instance_types"].([]any)
			if !ok || len(types) == 0 {
				t.Fatal("the heavy profile must pin an explicit instance_types — without it the guard falls back to node-count only")
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
				t.Fatalf("heavy profile pins %q, which packages/core/catalog/catalog.json does not offer for %s — "+
					"the harness would prove a node shape the console can never emit", want, cloud)
			}

			ns, ok := profile["node_size"].(map[string]any)
			if !ok {
				t.Fatal("the heavy profile must declare node_size — it is the only capacity signal the guard can enforce")
			}
			vcpu, _ := t2Num(ns["vcpu"])
			mem, _ := t2Num(ns["memory_gb"])
			if vcpu != found.VCPU || mem != found.MemoryGB {
				t.Errorf("heavy profile declares node_size %.0fvCPU/%.0fGB but %q is %.0fvCPU/%.0fGB in the catalog — "+
					"node_size is what the floor is enforced against, so a wrong pair makes the guard assert a machine that will not exist",
					vcpu, mem, want, found.VCPU, found.MemoryGB)
			}
		})
	}
}

// TestHeavyProfilesSurviveTheRealConfigValidator is the guard the previous two do not give: they
// judge the heavy profile IN ISOLATION, and the profile is never used in isolation.
//
// ALETHIA_E2E_CLUSTER_JSON is merged KEY BY KEY onto whatever `cluster` block is already there
// (t2MergeClusterJSON), and on a full-bar run that block is max-config's own — NodeMinSize 2,
// NodeMaxSize 5, NodeDesiredSize 2. So a profile that raises min and desired but is SILENT about
// node_max_size inherits max-config's 5 and produces min=6 / max=5 / desired=6, which
// packages/core/cloud.validateNodeSizing refuses outright. Every managed cloud's profile happened to
// state all three; hetzner's stated two, and the resulting ProjectConfig was rejected by
// provider.ValidateConfig at deploy.go:502 — a plan-time hard failure on a real, main-gated leg, for
// a purely harness reason. Neither of the two guards above could see it: the merged shape clears the
// capacity floor (6 nodes, 24 vCPU, 48 GB) and cx33 is a real catalog instance.
//
// So this runs the composition the deploy actually runs: fold max-config, merge the profile exactly
// as the run merges it, decode into the real ProjectConfig, and hand it to the REAL provider
// validator. Fixing only the fixture would leave the class open for the next cloud added.
func TestHeavyProfilesSurviveTheRealConfigValidator(t *testing.T) {
	for _, provider := range maxConfigClouds() {
		t.Run(provider, func(t *testing.T) {
			// The composition order is t2DeploySnapshot's: MaxConfigSnapshot first, the per-cloud
			// cluster-json override second (so the workflow's shape wins on the keys it names).
			snapshot := map[string]any{
				"id": "e2e-audit", "project_name": "maxcfg", "environment_stage": "dev",
				"provider": provider, "region": "eu-central-1", "addons": []any{},
			}
			if err := MaxConfigSnapshot(snapshot, provider); err != nil {
				t.Fatalf("MaxConfigSnapshot(%s): %v", provider, err)
			}
			raw, err := json.Marshal(loadHeavyProfile(t, provider))
			if err != nil {
				t.Fatalf("re-marshal heavy profile: %v", err)
			}
			t.Setenv("ALETHIA_E2E_CLUSTER_JSON", string(raw))
			if err := t2MergeClusterJSON(snapshot); err != nil {
				t.Fatalf("merge heavy profile: %v", err)
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
			// The same call the dedicated deploy path makes before it plans anything
			// (packages/core/provisioner/deploy.go). A refusal here is a full-bar run that dies at
			// plan time — cheap in money, expensive in a week of main-gated latency.
			if err := cp.ValidateConfig(&pc); err != nil {
				t.Errorf("the %s full-bar snapshot (max-config cluster block + heavy profile) is REFUSED by the "+
					"provider's own ValidateConfig: %v\nmerged cluster block: %v\n"+
					"the heavy profile is merged KEY BY KEY onto max-config's cluster block, so it must state every "+
					"key whose max-config value it contradicts — node_max_size is the one that bites",
					provider, err, snapshot["cluster"])
			}
		})
	}
}

// loadHeavyProfile reads fixtures/cluster_json.heavy.<cloud>.json as the cluster block.
func loadHeavyProfile(t *testing.T, cloud string) map[string]any {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate the e2e package directory")
	}
	path := filepath.Join(filepath.Dir(thisFile), "fixtures", "cluster_json.heavy."+cloud+".json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read heavy profile fixture: %v — a full-bar run on this cloud hard-errors in the workflow without it", err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("parse heavy profile fixture: %v", err)
	}
	return m
}
