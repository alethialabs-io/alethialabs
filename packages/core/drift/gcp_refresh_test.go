// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package drift

import (
	"encoding/json"
	"strings"
	"testing"

	tfjson "github.com/hashicorp/terraform-json"
)

// testdata/gcp_fabric_refresh.json is the refresh-only plan of a freshly provisioned gcp Fabric,
// rebuilt from #845 run 36740452010 attempt 2 (gcp, dimension=floor, fabric_demo=true, job
// "Provision + verify + teardown (real cloud) (gcp)"), whose drift re-prove read in_sync=false
// drifted=1 normalized=8 — the ONLY failure of a run in which every tier converged.
//
// CAPTURED from that job's log: every one of the 9 drifted addresses and every attribute delta with
// its before/after as the "Objects have changed outside of OpenTofu" render printed them — above all
// the cluster's gained node_pool element and node_config, field for field, and the node pool's own
// three null -> empty node_config collections. Which attributes are NULL (not printed) was read off
// the render's "(N unchanged attributes hidden)" counts, which count non-null values only: the pool's
// 10 hidden attributes are exactly its non-null ones, so its name_prefix and operation are null.
//
// SCRUBBED: the GCP project id (-> example-project) and the project number. PLACEHOLDERS, because the
// run never printed them: the cluster's and the other resources' hidden unchanged attributes (equal
// on both sides), the network self-link, the endpoint, the CA certificate.
//
// SCHEMAS: testdata/gcp_provider_schemas.json is `tofu providers schema -json` for hashicorp/google
// 6.50.0 — the run's version ("Installed hashicorp/google v6.50.0") and the template's lock —
// trimmed to the 8 types used here with descriptions removed. MASKS are computed from it with
// OpenTofu's algorithm (jsonstate.SensitiveAsBool over the values plus the schema's marks);
// google_container_cluster.master_auth.client_key is the only sensitive attribute among them.
//
// The check that this is the real shape: with no state evidence (the tier this change adds cannot
// fire) the analyzer reports EXACTLY run 36740452010's posture line — TestGCPFixtureReproducesTheRun.

const (
	gcpFixture = "gcp_fabric_refresh.json"
	gcpSchemas = "gcp_provider_schemas.json"
	gcpProv    = "registry.opentofu.org/hashicorp/google"

	gkeClusterAddr = "module.gke[0].google_container_cluster.cluster"
	gkePool        = "module.gke[0].google_container_node_pool.default[0]"
	gkeModule      = "module.gke[0]"

	// runPosture is the "Drift posture:" line run 36740452010 printed, verbatim. It carries paths
	// and reasons only — no value — which is the posture's contract.
	runPosture = `{"in_sync":false,"drifted":1,"details":[{"address":"module.gke[0].google_container_cluster.cluster","type":"google_container_cluster","kind":"modified","attributes":["node_config","node_pool"]}],"normalized":8,"normalized_details":[{"address":"google_kms_crypto_key.gke_secrets[0]","type":"google_kms_crypto_key","attributes":["labels"],"reason":"empty_collection"},{"address":"google_service_account_iam_member.external_dns_wi[0]","type":"google_service_account_iam_member","attributes":["etag"],"reason":"computed_attribute"},{"address":"module.gke[0].google_container_node_pool.default[0]","type":"google_container_node_pool","attributes":["node_config[0].resource_manager_tags","node_config[0].storage_pools","node_config[0].tags"],"reason":"empty_collection"},{"address":"module.vpc_network[0].google_compute_firewall.allow_health_checks","type":"google_compute_firewall","attributes":["source_service_accounts","source_tags","target_service_accounts","target_tags"],"reason":"empty_collection"},{"address":"module.vpc_network[0].google_compute_firewall.allow_internal","type":"google_compute_firewall","attributes":["source_service_accounts","source_tags","target_service_accounts","target_tags"],"reason":"empty_collection"},{"address":"module.vpc_network[0].google_compute_global_address.private_service_access","type":"google_compute_global_address","attributes":["labels"],"reason":"empty_collection"},{"address":"module.vpc_network[0].google_compute_router.router","type":"google_compute_router","attributes":["bgp[0].advertised_groups"],"reason":"empty_collection"},{"address":"module.vpc_network[0].google_compute_subnetwork.private","type":"google_compute_subnetwork","attributes":["log_config[0].metadata_fields"],"reason":"empty_collection"}],"unmanaged":0,"unmanaged_known":false}`
)

// withGCPSchemas analyzes plan the way the runner does once the schema-free pass drifted.
func withGCPSchemas(t *testing.T) func(*tfjson.Plan) *Posture {
	t.Helper()
	doc := loadSchemas(t, gcpSchemas)
	return func(p *tfjson.Plan) *Posture { return AnalyzeWithSchemas(p, doc) }
}

// TestGCPFixtureReproducesTheRun is the fixture's fidelity check: without prior_state no
// back-reference can be proven, and what is left is the analyzer as it stood before this tier —
// which must print run 36740452010's posture byte for byte.
func TestGCPFixtureReproducesTheRun(t *testing.T) {
	plan := loadPlan(t, gcpFixture)
	plan.PriorState = nil
	b, err := json.Marshal(withGCPSchemas(t)(plan))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if string(b) != runPosture {
		t.Fatalf("posture differs from the run's:\n got %s\nwant %s", b, runPosture)
	}
}

// TestGCPFabricRefreshIsInSync is the run stated as the fixed verdict: the cluster's node_pool and
// node_config are the pool google_container_node_pool.default[0] reported back on it, and every
// other dismissal is the run's own, unchanged.
func TestGCPFabricRefreshIsInSync(t *testing.T) {
	p := withGCPSchemas(t)(loadPlan(t, gcpFixture))
	if !p.InSync || p.Drifted != 0 || p.Normalized != 9 {
		t.Fatalf("want in sync with 9 dismissed, got drifted=%d normalized=%d %+v", p.Drifted, p.Normalized, p.Details)
	}
	var run Posture
	if err := json.Unmarshal([]byte(runPosture), &run); err != nil {
		t.Fatal(err)
	}
	want := map[string]NormalizedResource{gkeClusterAddr: {
		Address: gkeClusterAddr, Type: "google_container_cluster", Attributes: []string{"node_config", "node_pool"},
		Reason: ReasonAssignmentBackReference,
	}}
	for _, n := range run.NormalizedDetails {
		want[n.Address] = n
	}
	for _, n := range p.NormalizedDetails {
		w, ok := want[n.Address]
		if !ok {
			t.Errorf("unexpected dismissal %s", n.Address)
			continue
		}
		if n.Reason != w.Reason || strings.Join(n.Attributes, ",") != strings.Join(w.Attributes, ",") {
			t.Errorf("%s: %s %v, want %s %v", n.Address, n.Reason, n.Attributes, w.Reason, w.Attributes)
		}
		delete(want, n.Address)
	}
	for a := range want {
		t.Errorf("missing dismissal %s", a)
	}
}

// TestGCPWithoutSchemasKeepsOnlyTheEtag pins the schema-free first pass: the back-reference needs no
// schema, so the cluster is dismissed already, and the only drift left is the server-set etag that
// only the schema can prove computed-only. That pass drifting is what makes the runner fetch them.
func TestGCPWithoutSchemasKeepsOnlyTheEtag(t *testing.T) {
	p := Analyze(loadPlan(t, gcpFixture))
	if p.Drifted != 1 || p.Normalized != 8 || p.Details[0].Type != "google_service_account_iam_member" {
		t.Fatalf("drifted=%d normalized=%d, want only the iam member's etag: %+v", p.Drifted, p.Normalized, p.Details)
	}
}

// TestGCPDismissalsCarryNoValues extends Table F to the gcp dismissals: the posture carries paths,
// never values — no project, pool, cluster name, machine type, label, URL or CIDR from the fixture.
func TestGCPDismissalsCarryNoValues(t *testing.T) {
	p := withGCPSchemas(t)(loadPlan(t, gcpFixture))
	if p.Normalized != 9 {
		t.Fatalf("Normalized = %d, want 9 — a value check over fewer dismissals proves less", p.Normalized)
	}
	b, err := json.Marshal(p)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, v := range []string{
		"example-project", "123456789012", "a10049e", "gke-ew3-", "e2-standard-4", "COS_CONTAINERD", "pd-standard",
		"cloud-platform", "GKE_METADATA", "europe-west3", "googleapis.com", "10.1.0.0", "alethia_e2e-run", "on-demand",
		"1.35.8", "BwZcta",
	} {
		if strings.Contains(string(b), v) {
			t.Errorf("posture leaks value %q", v)
		}
	}
}

// ── Table O — the gcp back-reference tier ────────────────────────────────────────────────────

// gcpRows runs the cluster's adversarial table: the unmodified fixture must dismiss the cluster as a
// back-reference (the control — without it every row could pass for the wrong reason), each `keep`
// row changes ONE thing after which the cluster must stay drift (and not be lost), and each `admit`
// row changes one thing the rule deliberately tolerates, after which it must still be dismissed.
func gcpRows(t *testing.T, keep, admit map[string]func(t *testing.T, plan *tfjson.Plan)) {
	t.Helper()
	analyze := withGCPSchemas(t)
	find := func(p *Posture) (dismissed *NormalizedResource, drifted *ResourceDrift) {
		for i := range p.NormalizedDetails {
			if p.NormalizedDetails[i].Address == gkeClusterAddr {
				return &p.NormalizedDetails[i], nil
			}
		}
		for i := range p.Details {
			if p.Details[i].Address == gkeClusterAddr {
				return nil, &p.Details[i]
			}
		}
		return nil, nil
	}
	admit["control: the fixture cluster is dismissed"] = func(*testing.T, *tfjson.Plan) {}
	for name, mutate := range admit {
		t.Run("admit/"+name, func(t *testing.T) {
			plan := loadPlan(t, gcpFixture)
			mutate(t, plan)
			n, _ := find(analyze(plan))
			if n == nil || n.Reason != ReasonAssignmentBackReference {
				t.Fatalf("cluster not dismissed as a back-reference: %+v", n)
			}
		})
	}
	for name, mutate := range keep {
		t.Run("keep/"+name, func(t *testing.T) {
			plan := loadPlan(t, gcpFixture)
			mutate(t, plan)
			n, d := find(analyze(plan))
			if n != nil {
				t.Fatalf("cluster was dismissed (%s) — this narrowing must keep it as drift", n.Reason)
			}
			if d == nil {
				t.Fatal("cluster is neither dismissed nor drifted")
			}
		})
	}
}

// clusterPool returns the cluster's refreshed node_pool element i (drift after).
func clusterPool(t *testing.T, plan *tfjson.Plan, i int) map[string]any {
	t.Helper()
	return after(t, plan, gkeClusterAddr)["node_pool"].([]any)[i].(map[string]any)
}

// firstMap returns the first element of a nested block list.
func firstMap(v any) map[string]any { return v.([]any)[0].(map[string]any) }

// poolViews returns the pool's refreshed value (prior_state) and recorded value (drift before).
func poolViews(t *testing.T, plan *tfjson.Plan) (live, rec map[string]any) {
	t.Helper()
	return statePrior(t, plan, gkePool).AttributeValues, before(t, plan, gkePool)
}

// setBoth writes key on the pool in both views.
func setPoolBoth(t *testing.T, plan *tfjson.Plan, key string, v any) {
	live, rec := poolViews(t, plan)
	live[key], rec[key] = v, v
}

// deepCopy returns an independent copy of a JSON value.
func deepCopy(t *testing.T, v any) any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestTableO_NodePoolBackReference(t *testing.T) {
	keep := map[string]func(t *testing.T, plan *tfjson.Plan){
		// ── the pool the element stands for must be managed here ──
		"the pool is not in state at all (created out of band)": func(t *testing.T, plan *tfjson.Plan) {
			setPoolBoth(t, plan, "name", "other-pool")
		},
		"the pool is in the refreshed view only": func(t *testing.T, plan *tfjson.Plan) {
			driftEntry(t, plan, gkePool).Change.Before = nil
		},
		"the recorded pool names another cluster": func(t *testing.T, plan *tfjson.Plan) {
			_, rec := poolViews(t, plan)
			rec["cluster"] = "someone-elses-cluster"
		},
		"the pool names another cluster": func(t *testing.T, plan *tfjson.Plan) {
			setPoolBoth(t, plan, "cluster", "someone-elses-cluster")
		},
		"the pool is in another project": func(t *testing.T, plan *tfjson.Plan) {
			setPoolBoth(t, plan, "project", "another-project")
		},
		"the pool is in another location": func(t *testing.T, plan *tfjson.Plan) {
			setPoolBoth(t, plan, "location", "us-central1-a")
		},
		"the pool is in another module instance": func(t *testing.T, plan *tfjson.Plan) {
			movePool(t, plan, "module.other[0]", gcpProv)
		},
		"the pool is under another provider (google-beta)": func(t *testing.T, plan *tfjson.Plan) {
			movePool(t, plan, gkeModule, "registry.opentofu.org/hashicorp/google-beta")
		},
		"two managed pools claim the element (ambiguous)": func(t *testing.T, plan *tfjson.Plan) {
			twin := *statePrior(t, plan, gkePool)
			twin.Address = "module.gke[0].google_container_node_pool.twin"
			addState(plan, gkeModule, &twin)
		},
		"the pool resource is a data source": func(t *testing.T, plan *tfjson.Plan) {
			statePrior(t, plan, gkePool).Mode = tfjson.DataResourceMode
		},
		// ── the element must mirror what the pool resource itself reports ──
		"the element reports a node count the pool does not": func(t *testing.T, plan *tfjson.Plan) {
			clusterPool(t, plan, 0)["node_count"] = 5.0
		},
		"the element reports a machine type the pool does not": func(t *testing.T, plan *tfjson.Plan) {
			firstMap(clusterPool(t, plan, 0)["node_config"])["machine_type"] = "n2-highmem-32"
		},
		"the element reports an extra label": func(t *testing.T, plan *tfjson.Plan) {
			firstMap(clusterPool(t, plan, 0)["node_config"])["labels"].(map[string]any)["x"] = "y"
		},
		"the element carries a field the pool resource has no value for": func(t *testing.T, plan *tfjson.Plan) {
			live, _ := poolViews(t, plan)
			delete(live, "max_pods_per_node")
		},
		"the element's upgrade settings are a different shape": func(t *testing.T, plan *tfjson.Plan) {
			clusterPool(t, plan, 0)["upgrade_settings"] = map[string]any{"max_surge": 1.0}
		},
		"the element's node locations differ in length": func(t *testing.T, plan *tfjson.Plan) {
			clusterPool(t, plan, 0)["node_locations"] = []any{"a", "b"}
		},
		"the element names no pool": func(t *testing.T, plan *tfjson.Plan) {
			delete(clusterPool(t, plan, 0), "name")
		},
		// ── fields filled from prior state must hold what an empty prior yields ──
		"the element has a name_prefix": func(t *testing.T, plan *tfjson.Plan) {
			clusterPool(t, plan, 0)["name_prefix"] = "x-"
		},
		"the element's name_prefix is not a string": func(t *testing.T, plan *tfjson.Plan) {
			clusterPool(t, plan, 0)["name_prefix"] = 1.0
		},
		"the element's create_pod_range is true": func(t *testing.T, plan *tfjson.Plan) {
			firstMap(clusterPool(t, plan, 0)["network_config"])["create_pod_range"] = true
		},
		"the element's create_pod_range is not a bool": func(t *testing.T, plan *tfjson.Plan) {
			firstMap(clusterPool(t, plan, 0)["network_config"])["create_pod_range"] = "true"
		},
		"the element carries a taint": func(t *testing.T, plan *tfjson.Plan) {
			firstMap(clusterPool(t, plan, 0)["node_config"])["taint"] = []any{map[string]any{"key": "k"}}
		},
		"the element's network_config is not a block list": func(t *testing.T, plan *tfjson.Plan) {
			clusterPool(t, plan, 0)["network_config"] = "x"
		},
		// ── the list itself: gained only, one element per pool ──
		"an out-of-band pool is gained alongside the managed one": func(t *testing.T, plan *tfjson.Plan) {
			a := after(t, plan, gkeClusterAddr)
			rogue := deepCopy(t, clusterPool(t, plan, 0)).(map[string]any)
			rogue["name"] = "rogue-pool"
			a["node_pool"] = append(a["node_pool"].([]any), rogue)
		},
		"the managed pool is listed twice": func(t *testing.T, plan *tfjson.Plan) {
			a := after(t, plan, gkeClusterAddr)
			a["node_pool"] = append(a["node_pool"].([]any), deepCopy(t, clusterPool(t, plan, 0)))
		},
		"a recorded pool was removed": func(t *testing.T, plan *tfjson.Plan) {
			old := deepCopy(t, clusterPool(t, plan, 0)).(map[string]any)
			old["name"] = "retired-pool"
			before(t, plan, gkeClusterAddr)["node_pool"] = []any{old}
		},
		"a recorded pool was altered": func(t *testing.T, plan *tfjson.Plan) {
			old := deepCopy(t, clusterPool(t, plan, 0)).(map[string]any)
			old["node_count"] = 1.0
			before(t, plan, gkeClusterAddr)["node_pool"] = []any{old}
			// node_config then has a non-empty first pool it is not re-verified against; keep it
			// equal so this row isolates node_pool.
			before(t, plan, gkeClusterAddr)["node_config"] = after(t, plan, gkeClusterAddr)["node_config"]
		},
		"the recorded pools were only reordered, none gained": func(t *testing.T, plan *tfjson.Plan) {
			other := deepCopy(t, clusterPool(t, plan, 0)).(map[string]any)
			other["name"] = "kept-pool"
			a := after(t, plan, gkeClusterAddr)
			a["node_pool"] = append(a["node_pool"].([]any), other)
			before(t, plan, gkeClusterAddr)["node_pool"] = []any{deepCopy(t, other), deepCopy(t, clusterPool(t, plan, 0))}
		},
		"node_pool is not a list": func(t *testing.T, plan *tfjson.Plan) {
			after(t, plan, gkeClusterAddr)["node_pool"] = map[string]any{}
		},
		"a node_pool element is not an object": func(t *testing.T, plan *tfjson.Plan) {
			a := after(t, plan, gkeClusterAddr)
			a["node_pool"] = append(a["node_pool"].([]any), "x")
		},
		// ── the cluster itself ──
		"the cluster's name changed": func(t *testing.T, plan *tfjson.Plan) {
			after(t, plan, gkeClusterAddr)["name"] = "renamed"
		},
		"the cluster has no project": func(t *testing.T, plan *tfjson.Plan) {
			delete(before(t, plan, gkeClusterAddr), "project")
			delete(after(t, plan, gkeClusterAddr), "project")
		},
		"the cluster is under google-beta": func(t *testing.T, plan *tfjson.Plan) {
			driftEntry(t, plan, gkeClusterAddr).ProviderName = "registry.opentofu.org/hashicorp/google-beta"
		},
		"no prior_state": func(t *testing.T, plan *tfjson.Plan) {
			plan.PriorState = nil
		},
	}
	admit := map[string]func(t *testing.T, plan *tfjson.Plan){
		"the pool names the cluster by id": func(t *testing.T, plan *tfjson.Plan) {
			setPoolBoth(t, plan, "cluster", after(t, plan, gkeClusterAddr)["id"])
		},
		"the recorded lists are null rather than empty": func(t *testing.T, plan *tfjson.Plan) {
			b := before(t, plan, gkeClusterAddr)
			b["node_pool"], b["node_config"] = nil, nil
		},
		"the pool configures a taint the cluster's read filters out": func(t *testing.T, plan *tfjson.Plan) {
			live, _ := poolViews(t, plan)
			firstMap(live["node_config"])["taint"] = []any{map[string]any{"key": "k", "value": "v", "effect": "NO_SCHEDULE"}}
		},
		"the element's prior-derived fields are the zero value, not null": func(t *testing.T, plan *tfjson.Plan) {
			e := clusterPool(t, plan, 0)
			e["name_prefix"] = ""
			firstMap(e["node_config"])["taint"] = []any{}
			firstMap(after(t, plan, gkeClusterAddr)["node_config"])["taint"] = []any{}
		},
		"an empty collection on one side is null on the other": func(t *testing.T, plan *tfjson.Plan) {
			firstMap(clusterPool(t, plan, 0)["node_config"])["resource_manager_tags"] = nil
			live, _ := poolViews(t, plan)
			delete(firstMap(live["node_config"]), "storage_pools")
		},
		"a recorded pool survives verbatim beside the gained one": func(t *testing.T, plan *tfjson.Plan) {
			kept := deepCopy(t, clusterPool(t, plan, 0)).(map[string]any)
			kept["name"] = "kept-pool"
			a := after(t, plan, gkeClusterAddr)
			a["node_pool"] = append(a["node_pool"].([]any), kept)
			before(t, plan, gkeClusterAddr)["node_pool"] = []any{deepCopy(t, kept)}
		},
	}
	gcpRows(t, keep, admit)
}

func TestTableO_NodeConfigBackReference(t *testing.T) {
	keep := map[string]func(t *testing.T, plan *tfjson.Plan){
		"the recorded node_config was not empty": func(t *testing.T, plan *tfjson.Plan) {
			nc := deepCopy(t, after(t, plan, gkeClusterAddr)["node_config"]).([]any)
			nc[0].(map[string]any)["machine_type"] = "e2-medium"
			before(t, plan, gkeClusterAddr)["node_config"] = nc
		},
		"the cluster kept its default pool": func(t *testing.T, plan *tfjson.Plan) {
			before(t, plan, gkeClusterAddr)["remove_default_node_pool"] = nil
			after(t, plan, gkeClusterAddr)["remove_default_node_pool"] = nil
		},
		"remove_default_node_pool is true only in the refreshed view": func(t *testing.T, plan *tfjson.Plan) {
			before(t, plan, gkeClusterAddr)["remove_default_node_pool"] = false
		},
		"the node config matches no pool": func(t *testing.T, plan *tfjson.Plan) {
			firstMap(after(t, plan, gkeClusterAddr)["node_config"])["machine_type"] = "n2-highmem-32"
		},
		"the node config carries a taint": func(t *testing.T, plan *tfjson.Plan) {
			firstMap(after(t, plan, gkeClusterAddr)["node_config"])["taint"] = []any{map[string]any{"key": "k"}}
		},
		"the node config is not a block list": func(t *testing.T, plan *tfjson.Plan) {
			after(t, plan, gkeClusterAddr)["node_config"] = []any{"x"}
		},
		"the node config went away": func(t *testing.T, plan *tfjson.Plan) {
			before(t, plan, gkeClusterAddr)["node_config"] = []any{map[string]any{}}
			after(t, plan, gkeClusterAddr)["node_config"] = []any{}
		},
		"the first pool is not managed here": func(t *testing.T, plan *tfjson.Plan) {
			// node_pool is unchanged (recorded == refreshed), so only node_config is judged — against a
			// first pool no resource in state stands for.
			a := after(t, plan, gkeClusterAddr)
			a["node_pool"].([]any)[0].(map[string]any)["name"] = "rogue-pool"
			before(t, plan, gkeClusterAddr)["node_pool"] = deepCopy(t, a["node_pool"])
		},
		"there is no pool at all": func(t *testing.T, plan *tfjson.Plan) {
			after(t, plan, gkeClusterAddr)["node_pool"] = []any{}
		},
		"node_pool is unreadable": func(t *testing.T, plan *tfjson.Plan) {
			before(t, plan, gkeClusterAddr)["node_pool"] = "x"
			after(t, plan, gkeClusterAddr)["node_pool"] = "x"
		},
	}
	admit := map[string]func(t *testing.T, plan *tfjson.Plan){
		"node_pool was already recorded, only node_config gained": func(t *testing.T, plan *tfjson.Plan) {
			before(t, plan, gkeClusterAddr)["node_pool"] = deepCopy(t, after(t, plan, gkeClusterAddr)["node_pool"])
		},
	}
	gcpRows(t, keep, admit)
}

// movePool moves the pool into another module instance and/or provider, in both views.
func movePool(t *testing.T, plan *tfjson.Plan, module, provider string) {
	t.Helper()
	sr := statePrior(t, plan, gkePool)
	sr.ProviderName = provider
	rc := driftEntry(t, plan, gkePool)
	rc.ProviderName = provider
	if module == gkeModule {
		return
	}
	// Remove it from module.gke[0] and re-home it.
	for _, m := range plan.PriorState.Values.RootModule.ChildModules {
		if m.Address != gkeModule {
			continue
		}
		kept := m.Resources[:0]
		for _, r := range m.Resources {
			if r.Address != gkePool {
				kept = append(kept, r)
			}
		}
		m.Resources = kept
	}
	addState(plan, module, sr)
	rc.ModuleAddress = module
}

// TestMirrorsShapes pins the value equivalence the mirror uses, including the shapes the fixture
// never reaches: null and empty collections are one value, scalars are never interchangeable.
func TestMirrorsShapes(t *testing.T) {
	for _, c := range []struct {
		a, b any
		want bool
	}{
		{nil, []any{}, true},
		{map[string]any{}, nil, true},
		{map[string]any{"a": nil}, map[string]any{}, true},
		{map[string]any{}, map[string]any{"a": []any{}}, true},
		{map[string]any{}, map[string]any{"a": "x"}, false},
		{map[string]any{"a": 1.0}, []any{1.0}, false},
		{[]any{1.0}, map[string]any{"a": 1.0}, false},
		{"", nil, false},
		{false, nil, false},
		{0.0, false, false},
		{[]any{"a"}, []any{"a"}, true},
		{[]any{"a"}, []any{"b"}, false},
		{[]any{"a"}, []any{"a", "b"}, false},
	} {
		if got := mirrors(c.a, c.b); got != c.want {
			t.Errorf("mirrors(%#v, %#v) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}

// TestWithoutPriorDerivedPoolSide pins the pool side of the prior-derived strip: the pool's own
// configured values are legitimate there and are removed without judgement, and an unreadable
// block makes the whole comparison fail closed.
func TestWithoutPriorDerivedPoolSide(t *testing.T) {
	got, ok := withoutPriorDerived(map[string]any{
		"name_prefix":    "p-",
		"network_config": []any{map[string]any{"create_pod_range": true, "pod_range": "r"}},
		"node_config":    []any{map[string]any{"taint": []any{map[string]any{"key": "k"}}, "machine_type": "m"}},
	}, false)
	if !ok {
		t.Fatal("pool side refused its own configured values")
	}
	b, _ := json.Marshal(got)
	if string(b) != `{"network_config":[{"pod_range":"r"}],"node_config":[{"machine_type":"m"}]}` {
		t.Fatalf("strip = %s", b)
	}
	if _, ok := withoutPriorDerived(map[string]any{"node_config": "x"}, false); ok {
		t.Fatal("an unreadable node_config must fail closed")
	}
}
