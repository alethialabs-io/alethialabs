// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package drift

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	tfjson "github.com/hashicorp/terraform-json"
	"github.com/zclconf/go-cty/cty"
)

// testdata/hetzner_fabric_refresh.json is the refresh-only plan of a freshly provisioned hetzner
// Fabric (1 control plane + 3 workers), rebuilt from #845 run 36667774857. What is CAPTURED from
// that run's log: the seven drifted addresses, their attribute paths, and the hcloud before/after
// values (assignee_id 0 -> <server id>, assignee_type "unassigned" -> "server", apply_to [] ->
// one {server = <id>} per server), with the run's real resource ids. The same class, scaled to 1+1
// nodes, appears in the plain floor soak of 2026-08-25 (demos/proofs/hetzner/20260825T192100Z,
// drift_baseline) — no placement ran there, so it is not placement-caused.
//
// The SENSITIVITY MASKS are not captured — the runner never prints plan JSON — but they are no
// longer guessed either. The first version of this file reconstructed them from an assumed
// mechanism (talos masks that DIFFER, firewall masks of `{}`), and run 36706419571 refuted both:
// the runner reported the firewall and both talos resources as drift. They are now COMPUTED with
// OpenTofu v1.9.0's own algorithm — jsonplan prints each side as
// SensitiveAsBoolWithPathValueMarks(value, marks ∪ schema.ValueMarks(value)) — from the provider
// schemas in testdata/hetzner_provider_schemas.json, which is `tofu providers schema -json` for
// hetznercloud/hcloud 1.67.0 and siderolabs/talos 0.11.0 (the run's lock), trimmed to the five
// types used here. Two value details also come from run 36706419571's teardown render: an
// apply_to element's label_selector and the ICMP rule's port are null, not "".
//
// The check that this is now the real shape: against this fixture, the analyzer as merged in
// #5167 reports EXACTLY run 36706419571's posture — drifted=3 (hcloud_firewall.this attrs
// [apply_to]; talos_cluster_kubeconfig.this and talos_machine_secrets.this with no attribute),
// normalized=4 (the primary IPs).

const (
	hetznerFixture = "hetzner_fabric_refresh.json"
	hetznerSchemas = "hetzner_provider_schemas.json"
)

// loadSchemas reads a `providers schema -json` document from testdata.
func loadSchemas(t *testing.T, name string) *tfjson.ProviderSchemas {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	var doc tfjson.ProviderSchemas
	if err := json.Unmarshal(b, &doc); err != nil {
		t.Fatalf("unmarshal %s: %v", name, err)
	}
	return &doc
}

// withHetznerSchemas analyzes plan the way the runner does once the schema-free pass drifted.
func withHetznerSchemas(t *testing.T) func(*tfjson.Plan) *Posture {
	t.Helper()
	doc := loadSchemas(t, hetznerSchemas)
	return func(p *tfjson.Plan) *Posture { return AnalyzeWithSchemas(p, doc) }
}

// driftEntry returns the fixture's resource_drift entry at addr, failing the test if absent.
func driftEntry(t *testing.T, plan *tfjson.Plan, addr string) *tfjson.ResourceChange {
	t.Helper()
	for _, rc := range plan.ResourceDrift {
		if rc.Address == addr {
			return rc
		}
	}
	t.Fatalf("fixture has no drift entry %s", addr)
	return nil
}

// priorEntry returns the fixture's prior_state resource at addr, failing the test if absent.
func priorEntry(t *testing.T, plan *tfjson.Plan, addr string) *tfjson.StateResource {
	t.Helper()
	for _, r := range plan.PriorState.Values.RootModule.Resources {
		if r.Address == addr {
			return r
		}
	}
	t.Fatalf("fixture has no prior_state resource %s", addr)
	return nil
}

// onlyDrift keeps just the drift entry at addr, so a verdict can be asserted on it alone while
// the rest of the plan (prior_state) stays intact as evidence.
func onlyDrift(t *testing.T, plan *tfjson.Plan, addr string) *tfjson.Plan {
	t.Helper()
	plan.ResourceDrift = []*tfjson.ResourceChange{driftEntry(t, plan, addr)}
	return plan
}

const (
	cpIP      = "hcloud_primary_ip.control_plane_ipv4[0]"
	firewall  = "hcloud_firewall.this"
	cpServer  = `hcloud_server.control_planes["alethia-nl-36667774857-1-cp-1"]`
	secrets   = "talos_machine_secrets.this"
	kubecfg   = "talos_cluster_kubeconfig.this"
	cpSrvID   = 168043102.0
	w1SrvID   = 168043103.0
	unknownID = 999999999.0
)

// TestHetznerFabricRefreshIsInSync is the #845 failure, stated as the fixed verdict: a freshly
// provisioned hetzner Fabric reads IN SYNC, with all seven resources recorded as dismissed and
// every dismissal naming its attributes and its reason. The runner fetches provider schemas
// whenever the schema-free pass drifted (packages/core/provisioner/drift.go), so this is the
// verdict a customer's Fabric gets.
func TestHetznerFabricRefreshIsInSync(t *testing.T) {
	p := withHetznerSchemas(t)(loadPlan(t, hetznerFixture))
	if !p.InSync || p.Drifted != 0 {
		t.Fatalf("want in sync, got in_sync=%t drifted=%d details=%+v", p.InSync, p.Drifted, p.Details)
	}
	if p.Normalized != 7 {
		t.Fatalf("Normalized = %d, want 7 (%+v)", p.Normalized, p.NormalizedDetails)
	}
	want := map[string]struct {
		reason NormalizedReason
		attrs  string
	}{
		firewall:                           {ReasonAssignmentBackReference, "apply_to"},
		cpIP:                               {ReasonAssignmentBackReference, "assignee_id,assignee_type"},
		"hcloud_primary_ip.worker_ipv4[0]": {ReasonAssignmentBackReference, "assignee_id,assignee_type"},
		"hcloud_primary_ip.worker_ipv4[1]": {ReasonAssignmentBackReference, "assignee_id,assignee_type"},
		"hcloud_primary_ip.worker_ipv4[2]": {ReasonAssignmentBackReference, "assignee_id,assignee_type"},
		secrets: {ReasonSensitivityOnly, "client_configuration.client_key," +
			"machine_secrets.certs.etcd.key,machine_secrets.certs.k8s.key," +
			"machine_secrets.certs.k8s_aggregator.key,machine_secrets.certs.k8s_serviceaccount.key," +
			"machine_secrets.certs.os.key,machine_secrets.cluster.secret," +
			"machine_secrets.secrets.aescbc_encryption_secret,machine_secrets.secrets.bootstrap_token," +
			"machine_secrets.secrets.secretbox_encryption_secret,machine_secrets.trustdinfo.token"},
		kubecfg: {ReasonSensitivityOnly, "client_configuration.client_key,kubeconfig_raw,kubernetes_client_configuration.client_key"},
	}
	for _, n := range p.NormalizedDetails {
		w, ok := want[n.Address]
		if !ok {
			t.Errorf("unexpected dismissal %s", n.Address)
			continue
		}
		if n.Reason != w.reason {
			t.Errorf("%s: Reason = %q, want %q", n.Address, n.Reason, w.reason)
		}
		if got := strings.Join(n.Attributes, ","); got != w.attrs {
			t.Errorf("%s: Attributes = %s, want exactly %s", n.Address, got, w.attrs)
		}
	}
}

// TestHetznerWithoutSchemasKeepsOnlyTheTalosResources pins the fail-closed half: the schema-mark
// branch needs the provider schema, so the runner's schema-free first pass still reports the two
// talos resources — and ONLY them, since the hcloud back-references need no schema. That first
// pass drifting is what makes the runner fetch the schemas at all.
func TestHetznerWithoutSchemasKeepsOnlyTheTalosResources(t *testing.T) {
	for name, analyze := range map[string]func(*tfjson.Plan) *Posture{
		"Analyze":                 Analyze,
		"AnalyzeWithSchemas(nil)": func(p *tfjson.Plan) *Posture { return AnalyzeWithSchemas(p, nil) },
		"AnalyzeWithSchemas(unrelated)": func(p *tfjson.Plan) *Posture {
			return AnalyzeWithSchemas(p, schemasFor(gcpProvider, "google_storage_bucket", map[string]*tfjson.SchemaAttribute{"updated": {Computed: true}}))
		},
	} {
		t.Run(name, func(t *testing.T) {
			p := analyze(loadPlan(t, hetznerFixture))
			if p.Drifted != 2 || p.Normalized != 5 {
				t.Fatalf("drifted=%d normalized=%d, want 2 and 5: %+v", p.Drifted, p.Normalized, p.Details)
			}
			for _, d := range p.Details {
				if d.Address != secrets && d.Address != kubecfg {
					t.Errorf("unexpected drift %s", d.Address)
				}
			}
		})
	}
}

// TestHetznerDismissalsCarryNoValues extends Table F to the two new tiers: the posture carries
// paths, never values — the talos fixture's placeholder secrets and the primary IPs' addresses
// must not appear anywhere in the marshalled posture.
func TestHetznerDismissalsCarryNoValues(t *testing.T) {
	p := withHetznerSchemas(t)(loadPlan(t, hetznerFixture))
	if p.Normalized != 7 {
		t.Fatalf("Normalized = %d, want 7 — a value check over fewer dismissals proves less", p.Normalized)
	}
	b, err := json.Marshal(p)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, v := range []string{"fixture-key", "fixture-cluster-secret", "fixture.token", "203.0.113.", "168043102", "apiVersion"} {
		if strings.Contains(string(b), v) {
			t.Errorf("posture leaks value %q: %s", v, b)
		}
	}
}

// ── Table J — the back-reference tier: each narrowing alone keeps the delta as drift ─────────
//
// Every row starts from the fixture's REAL, dismissed control-plane IP (or firewall) and changes
// ONE thing. A tier that keyed on the attribute name or the resource type would dismiss them all.

func TestTableJ_PrimaryIPBackReferenceNarrowings(t *testing.T) {
	cases := map[string]func(t *testing.T, plan *tfjson.Plan){
		"no prior_state — no evidence of the owner": func(_ *testing.T, plan *tfjson.Plan) {
			plan.PriorState = nil
		},
		"assigned to a server that is NOT in state": func(t *testing.T, plan *tfjson.Plan) {
			driftEntry(t, plan, cpIP).Change.After.(map[string]any)["assignee_id"] = unknownID
		},
		"assigned to a managed server whose public_net does not hold this IP": func(t *testing.T, plan *tfjson.Plan) {
			driftEntry(t, plan, cpIP).Change.After.(map[string]any)["assignee_id"] = w1SrvID
		},
		"RE-assigned: before already named another server": func(t *testing.T, plan *tfjson.Plan) {
			driftEntry(t, plan, cpIP).Change.Before.(map[string]any)["assignee_id"] = w1SrvID
		},
		"after names a type other than server": func(t *testing.T, plan *tfjson.Plan) {
			driftEntry(t, plan, cpIP).Change.After.(map[string]any)["assignee_type"] = "load_balancer"
		},
		"the IP's own id changed": func(t *testing.T, plan *tfjson.Plan) {
			driftEntry(t, plan, cpIP).Change.After.(map[string]any)["id"] = 152443999.0
		},
		"the IP family changed": func(t *testing.T, plan *tfjson.Plan) {
			driftEntry(t, plan, cpIP).Change.After.(map[string]any)["type"] = "ipv6"
		},
		"a different provider (a fork publishing the same type)": func(t *testing.T, plan *tfjson.Plan) {
			driftEntry(t, plan, cpIP).ProviderName = "registry.opentofu.org/somefork/hcloudish"
		},
		"the owner is a data source, not a managed server": func(t *testing.T, plan *tfjson.Plan) {
			priorEntry(t, plan, cpServer).Mode = tfjson.DataResourceMode
		},
		"the owner is served by a DIFFERENT provider address": func(t *testing.T, plan *tfjson.Plan) {
			priorEntry(t, plan, cpServer).ProviderName = "registry.terraform.io/hetznercloud/hcloud"
		},
		"the forward edge exists LIVE but not in the RECORDED server (added out-of-band)": func(t *testing.T, plan *tfjson.Plan) {
			live := priorEntry(t, plan, cpServer).AttributeValues
			recorded := map[string]any{}
			for k, v := range live {
				recorded[k] = v
			}
			recorded["public_net"] = []any{map[string]any{"ipv4": 1.0, "ipv4_enabled": true, "ipv6": 0.0, "ipv6_enabled": true}}
			plan.ResourceDrift = append(plan.ResourceDrift, &tfjson.ResourceChange{
				Address: cpServer, Mode: tfjson.ManagedResourceMode, Type: "hcloud_server",
				ProviderName: driftEntry(t, plan, cpIP).ProviderName,
				Change:       &tfjson.Change{Actions: tfjson.Actions{tfjson.ActionUpdate}, Before: recorded, After: live},
			})
		},
		"the owner's recorded value is unreadable": func(t *testing.T, plan *tfjson.Plan) {
			plan.ResourceDrift = append(plan.ResourceDrift, &tfjson.ResourceChange{
				Address: cpServer, Mode: tfjson.ManagedResourceMode, Type: "hcloud_server",
				ProviderName: driftEntry(t, plan, cpIP).ProviderName,
				Change:       &tfjson.Change{Actions: tfjson.Actions{tfjson.ActionUpdate}, Before: "x", After: priorEntry(t, plan, cpServer).AttributeValues},
			})
		},
		"the sensitivity mask marks assignee_id": func(t *testing.T, plan *tfjson.Plan) {
			driftEntry(t, plan, cpIP).Change.AfterSensitive = map[string]any{"assignee_id": true}
		},
		"a real delta rides along — labels stripped out-of-band": func(t *testing.T, plan *tfjson.Plan) {
			driftEntry(t, plan, cpIP).Change.After.(map[string]any)["labels"] = map[string]any{}
		},
	}
	// The unmodified fixture is the control: it MUST be dismissed, or every row below passes
	// for the wrong reason.
	t.Run("control: the fixture IP is dismissed", func(t *testing.T) {
		assertDrift(t, Analyze(onlyDrift(t, loadPlan(t, hetznerFixture), cpIP)), false, ReasonAssignmentBackReference)
	})
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			plan := loadPlan(t, hetznerFixture)
			mutate(t, plan)
			p := Analyze(plan)
			for _, d := range p.NormalizedDetails {
				if d.Address == cpIP {
					t.Fatalf("%s was dismissed (%s) — this narrowing must keep it as drift", cpIP, d.Reason)
				}
			}
			found := false
			for _, d := range p.Details {
				found = found || d.Address == cpIP
			}
			if !found {
				t.Fatalf("%s is neither dismissed nor drifted: %+v", cpIP, p)
			}
		})
	}
}

func TestTableJ_FirewallBackReferenceNarrowings(t *testing.T) {
	applyTo := func(t *testing.T, plan *tfjson.Plan) []any {
		return driftEntry(t, plan, firewall).Change.After.(map[string]any)["apply_to"].([]any)
	}
	setApplyTo := func(t *testing.T, plan *tfjson.Plan, v []any) {
		driftEntry(t, plan, firewall).Change.After.(map[string]any)["apply_to"] = v
	}
	cases := map[string]func(t *testing.T, plan *tfjson.Plan){
		"a LABEL SELECTOR attached out-of-band": func(t *testing.T, plan *tfjson.Plan) {
			setApplyTo(t, plan, append(applyTo(t, plan), map[string]any{"label_selector": "role=anything", "server": nil}))
		},
		"a server entry for a server NOT in state": func(t *testing.T, plan *tfjson.Plan) {
			setApplyTo(t, plan, append(applyTo(t, plan), map[string]any{"label_selector": "", "server": unknownID}))
		},
		"a recorded entry was REMOVED": func(t *testing.T, plan *tfjson.Plan) {
			driftEntry(t, plan, firewall).Change.Before.(map[string]any)["apply_to"] = []any{
				map[string]any{"label_selector": "role=kept", "server": nil},
			}
		},
		"a managed server whose firewall_ids does not name this firewall": func(t *testing.T, plan *tfjson.Plan) {
			priorEntry(t, plan, cpServer).AttributeValues["firewall_ids"] = []any{1.0}
		},
		"an entry carrying a field this tier does not know": func(t *testing.T, plan *tfjson.Plan) {
			setApplyTo(t, plan, []any{map[string]any{"label_selector": "", "server": cpSrvID, "extra": "x"}})
		},
		"apply_to is not a list": func(t *testing.T, plan *tfjson.Plan) {
			setApplyTo(t, plan, nil)
			driftEntry(t, plan, firewall).Change.After.(map[string]any)["apply_to"] = "x"
		},
		"a firewall rule changed alongside": func(t *testing.T, plan *tfjson.Plan) {
			driftEntry(t, plan, firewall).Change.After.(map[string]any)["rule"] = []any{}
		},
		"the plan marks a value inside apply_to sensitive": func(t *testing.T, plan *tfjson.Plan) {
			driftEntry(t, plan, firewall).Change.AfterSensitive.(map[string]any)["apply_to"] = []any{
				map[string]any{}, map[string]any{"server": true}, map[string]any{}, map[string]any{},
			}
		},
	}
	t.Run("control: the fixture firewall is dismissed", func(t *testing.T) {
		assertDrift(t, Analyze(onlyDrift(t, loadPlan(t, hetznerFixture), firewall)), false, ReasonAssignmentBackReference)
	})
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			plan := onlyDrift(t, loadPlan(t, hetznerFixture), firewall)
			mutate(t, plan)
			assertDrift(t, Analyze(plan), true, "")
		})
	}
}

// ── Table K — the sensitivity-only tier ──────────────────────────────────────────────────────

func TestTableK_SensitivityOnlyNarrowings(t *testing.T) {
	analyze := withHetznerSchemas(t)
	// Both talos resources are the control: each MUST be dismissed with the captured schemas, or
	// every row below passes for the wrong reason.
	for _, addr := range []string{kubecfg, secrets} {
		t.Run("control: the fixture "+addr+" is dismissed", func(t *testing.T) {
			assertDrift(t, analyze(onlyDrift(t, loadPlan(t, hetznerFixture), addr)), false, ReasonSensitivityOnly)
		})
	}
	cases := map[string]func(t *testing.T, rc *tfjson.ResourceChange){
		"no masks at all — nothing the schema marked is on this value": func(_ *testing.T, rc *tfjson.ResourceChange) {
			rc.Change.BeforeSensitive, rc.Change.AfterSensitive = nil, nil
		},
		"masks of structure only — no path marked": func(_ *testing.T, rc *tfjson.ResourceChange) {
			rc.Change.BeforeSensitive = map[string]any{"client_configuration": map[string]any{}}
			rc.Change.AfterSensitive = map[string]any{"client_configuration": map[string]any{}}
		},
		"a NUMBER anywhere — equal JSON no longer proves equal values": func(_ *testing.T, rc *tfjson.ResourceChange) {
			rc.Change.Before.(map[string]any)["port"] = 6443.0
			rc.Change.After.(map[string]any)["port"] = 6443.0
		},
		"a sensitive VALUE changed — a real rotation is a leaf, not a mark": func(_ *testing.T, rc *tfjson.ResourceChange) {
			after := map[string]any{}
			for k, v := range rc.Change.Before.(map[string]any) {
				after[k] = v
			}
			after["kubeconfig_raw"] = "apiVersion: v1\n# rotated\n"
			rc.Change.After = after
		},
		"a non-sensitive VALUE changed — the endpoint moved": func(_ *testing.T, rc *tfjson.ResourceChange) {
			after := map[string]any{}
			for k, v := range rc.Change.Before.(map[string]any) {
				after[k] = v
			}
			after["endpoint"] = "198.51.100.7"
			rc.Change.After = after
		},
		"a non-update action": func(_ *testing.T, rc *tfjson.ResourceChange) {
			rc.Change.Actions = tfjson.Actions{tfjson.ActionDelete}
		},
		"a different provider (a fork publishing the same type)": func(_ *testing.T, rc *tfjson.ResourceChange) {
			rc.ProviderName = "registry.opentofu.org/somefork/talos"
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			plan := onlyDrift(t, loadPlan(t, hetznerFixture), kubecfg)
			mutate(t, plan.ResourceDrift[0])
			assertDrift(t, analyze(plan), true, "")
		})
	}
	// The schema is the evidence, so each way it can fail to explain the report keeps the drift.
	schemaCases := map[string]func(*tfjson.Schema){
		"the schema declares NOTHING sensitive — equal masks mean equal marks": func(s *tfjson.Schema) {
			clearSensitive(s.Block)
		},
		"the schema has a DYNAMIC attribute — equal JSON no longer proves equal values": func(s *tfjson.Schema) {
			s.Block.Attributes["extra"] = &tfjson.SchemaAttribute{AttributeType: cty.DynamicPseudoType, Optional: true}
		},
		"a dynamic attribute NESTED inside an object": func(s *tfjson.Schema) {
			s.Block.Attributes["client_configuration"].AttributeNestedType.Attributes["extra"] = &tfjson.SchemaAttribute{AttributeType: cty.List(cty.DynamicPseudoType)}
		},
		"a dynamic attribute inside a nested BLOCK": func(s *tfjson.Schema) {
			s.Block.NestedBlocks = map[string]*tfjson.SchemaBlockType{"b": {Block: &tfjson.SchemaBlock{
				Attributes: map[string]*tfjson.SchemaAttribute{"x": {AttributeType: cty.DynamicPseudoType}},
			}}}
		},
		"an attribute with neither a type nor a nested type": func(s *tfjson.Schema) {
			s.Block.Attributes["extra"] = &tfjson.SchemaAttribute{Optional: true}
		},
	}
	for name, mutate := range schemaCases {
		t.Run(name, func(t *testing.T) {
			doc := loadSchemas(t, hetznerSchemas)
			mutate(doc.Schemas["registry.opentofu.org/siderolabs/talos"].ResourceSchemas["talos_cluster_kubeconfig"])
			assertDrift(t, AnalyzeWithSchemas(onlyDrift(t, loadPlan(t, hetznerFixture), kubecfg), doc), true, "")
		})
	}
	t.Run("the SAME fixture without schemas stays drift", func(t *testing.T) {
		assertDrift(t, Analyze(onlyDrift(t, loadPlan(t, hetznerFixture), kubecfg)), true, "")
	})
	t.Run("empty objects with differing masks stay drift", func(t *testing.T) {
		rc := updateDrift("a.a", "a", map[string]any{}, map[string]any{})
		rc.Change.AfterSensitive = map[string]any{"x": true}
		assertDrift(t, Analyze(planWithConfig(nil, rc)), true, "")
	})
	t.Run("a mark REMOVED is equally a mark-only change", func(t *testing.T) {
		rc := updateDrift("a.a", "a", map[string]any{"s": "v"}, map[string]any{"s": "v"})
		rc.Change.BeforeSensitive = map[string]any{"s": true}
		p := Analyze(planWithConfig(nil, rc))
		assertDrift(t, p, false, ReasonSensitivityOnly)
		if got := p.NormalizedDetails[0].Attributes; len(got) != 1 || got[0] != "s" {
			t.Errorf("Attributes = %v, want [s]", got)
		}
	})
	t.Run("whole-object and list masks are read", func(t *testing.T) {
		rc := updateDrift("a.a", "a", map[string]any{"l": []any{"v"}}, map[string]any{"l": []any{"v"}})
		rc.Change.BeforeSensitive = true
		rc.Change.AfterSensitive = map[string]any{"l": []any{true}}
		p := Analyze(planWithConfig(nil, rc))
		assertDrift(t, p, false, ReasonSensitivityOnly)
		if got := strings.Join(p.NormalizedDetails[0].Attributes, ","); got != ".,l[0]" {
			t.Errorf("Attributes = %s, want .,l[0]", got)
		}
	})
}

// TestPlainIDShapes pins the id canonicalisation both hcloud checks compare through: string and
// number ids agree, and anything that is not a plain positive integer below 2^53 is refused.
func TestPlainIDShapes(t *testing.T) {
	for _, tc := range []struct {
		in   any
		want string
		ok   bool
	}{
		{"168043102", "168043102", true},
		{168043102.0, "168043102", true},
		{json.Number("168043102"), "168043102", true},
		{"", "", false},
		{"0", "", false},
		{0.0, "", false},
		{-1.0, "", false},
		{1.5, "", false},
		{float64(maxExactInt), "", false},
		{"9007199254740993", "", false},
		{"12abc", "", false},
		{true, "", false},
		{nil, "", false},
	} {
		got, ok := plainID(tc.in)
		if got != tc.want || ok != tc.ok {
			t.Errorf("plainID(%#v) = (%q, %t), want (%q, %t)", tc.in, got, ok, tc.want, tc.ok)
		}
	}
	for _, v := range []any{nil, 0.0, "", "0", json.Number("0")} {
		if !unassignedID(v) {
			t.Errorf("unassignedID(%#v) = false, want true", v)
		}
	}
	for _, v := range []any{1.0, "1", json.Number("7"), true} {
		if unassignedID(v) {
			t.Errorf("unassignedID(%#v) = true, want false", v)
		}
	}
}

// ── Table L — the fail-closed edges of the back-reference tier, called directly ─────────────
//
// Tables J and K drive the tier through Analyze from the captured fixture. These rows reach the
// shapes that fixture cannot express (an ipv6 IP, a nested module, a malformed apply_to) against
// a hand-built state index, so every refusal branch is exercised, and the one positive row that
// is not in the fixture (ipv6) proves the family switch is not a blanket refusal.

const hcloudProv = "registry.opentofu.org/hetznercloud/hcloud"

// srv is a managed hcloud_server state object with the given attribute values.
func srv(values map[string]any) stateObject {
	return stateObject{mode: tfjson.ManagedResourceMode, typ: "hcloud_server", provider: hcloudProv, values: values}
}

// sameViews is a state index whose recorded and refreshed views both hold objs.
func sameViews(objs map[string]stateObject) *stateIndex {
	st := &stateIndex{refreshed: map[string]stateObject{}, recorded: map[string]stateObject{}}
	for a, o := range objs {
		st.refreshed[a] = o
		st.recorded[a] = o
	}
	return st
}

func TestIndexStateWalksModulesAndSkipsJunk(t *testing.T) {
	child := &tfjson.StateResource{Address: "module.m.hcloud_server.s", Mode: tfjson.ManagedResourceMode, Type: "hcloud_server", ProviderName: hcloudProv, AttributeValues: map[string]any{"id": "7"}}
	plan := &tfjson.Plan{
		PriorState: &tfjson.State{Values: &tfjson.StateValues{RootModule: &tfjson.StateModule{
			Resources:    []*tfjson.StateResource{nil, {Address: ""}},
			ChildModules: []*tfjson.StateModule{nil, {Resources: []*tfjson.StateResource{child}}},
		}}},
		ResourceDrift: []*tfjson.ResourceChange{
			nil,
			{Address: "data.x.y", Mode: tfjson.DataResourceMode, Change: &tfjson.Change{Before: map[string]any{}}},
			{Address: child.Address, Mode: tfjson.ManagedResourceMode},
		},
	}
	st := indexState(plan)
	if st == nil {
		t.Fatal("indexState = nil for a plan with prior_state")
	}
	if len(st.refreshed) != 1 || st.refreshed[child.Address].values["id"] != "7" {
		t.Fatalf("refreshed = %+v, want only the child-module server", st.refreshed)
	}
	if _, ok := st.recorded[child.Address]; !ok {
		t.Fatalf("a drift entry with no Change must not replace the recorded view: %+v", st.recorded)
	}
	if _, ok := st.recorded["data.x.y"]; ok {
		t.Fatal("a data-source drift entry entered the recorded view")
	}
}

func TestTableL_PrimaryIPEdges(t *testing.T) {
	st := sameViews(map[string]stateObject{
		"hcloud_server.a": srv(map[string]any{"id": 11.0, "public_net": []any{"not-a-map", map[string]any{"ipv6": 5.0}}}),
	})
	ip := func(family string) (map[string]any, map[string]any) {
		return map[string]any{"id": 5.0, "type": family, "assignee_id": 0.0, "assignee_type": "unassigned"},
			map[string]any{"id": 5.0, "type": family, "assignee_id": 11.0, "assignee_type": "server"}
	}
	t.Run("control: an ipv6 IP held by a managed server is a back-reference", func(t *testing.T) {
		b, a := ip("ipv6")
		if got := hcloudPrimaryIPAssignment(hcloudProv, b, a, st); len(got) != 2 {
			t.Fatalf("got %v, want [assignee_id assignee_type]", got)
		}
	})
	for name, mutate := range map[string]func(b, a map[string]any){
		"an unknown IP family":                       func(b, a map[string]any) { b["type"], a["type"] = "ipv9", "ipv9" },
		"recorded assignee_type is a load balancer":  func(b, _ map[string]any) { b["assignee_type"] = "load_balancer" },
		"the after assignee_id is not a plain id":    func(_, a map[string]any) { a["assignee_id"] = "eleven" },
		"the edge is ipv4 but the server holds ipv6": func(b, a map[string]any) { b["type"], a["type"] = "ipv4", "ipv4" },
	} {
		t.Run(name, func(t *testing.T) {
			b, a := ip("ipv6")
			mutate(b, a)
			if got := hcloudPrimaryIPAssignment(hcloudProv, b, a, st); got != nil {
				t.Fatalf("got %v, want nil", got)
			}
		})
	}
}

func TestTableL_FirewallEdges(t *testing.T) {
	st := sameViews(map[string]stateObject{
		"hcloud_server.a": srv(map[string]any{"id": 11.0, "firewall_ids": []any{3.0}}),
		"hcloud_server.b": srv(map[string]any{"id": 12.0, "firewall_ids": []any{3.0}}),
	})
	entry := func(id float64) map[string]any { return map[string]any{"server": id, "label_selector": ""} }
	t.Run("control: a recorded entry survives and one managed server is gained", func(t *testing.T) {
		b := map[string]any{"id": 3.0, "apply_to": []any{entry(11)}}
		a := map[string]any{"id": 3.0, "apply_to": []any{entry(11), entry(12)}}
		if got := hcloudFirewallApplyTo(hcloudProv, b, a, st); len(got) != 1 || got[0] != "apply_to" {
			t.Fatalf("got %v, want [apply_to]", got)
		}
	})
	for name, ba := range map[string][2]map[string]any{
		"the firewall id changed": {
			{"id": 3.0, "apply_to": []any{}}, {"id": 4.0, "apply_to": []any{entry(11)}},
		},
		"the recorded apply_to is not a list": {
			{"id": 3.0, "apply_to": "x"}, {"id": 3.0, "apply_to": []any{entry(11)}},
		},
		"a gained element is not an object": {
			{"id": 3.0, "apply_to": []any{}}, {"id": 3.0, "apply_to": []any{"x"}},
		},
		"nothing was gained — an unexplained report": {
			{"id": 3.0, "apply_to": []any{entry(11)}}, {"id": 3.0, "apply_to": []any{entry(11)}},
		},
	} {
		t.Run(name, func(t *testing.T) {
			if got := hcloudFirewallApplyTo(hcloudProv, ba[0], ba[1], st); got != nil {
				t.Fatalf("got %v, want nil", got)
			}
		})
	}
}

func TestManagedServerHoldsRefusesARenumberedRecord(t *testing.T) {
	always := func(map[string]any) bool { return true }
	st := &stateIndex{
		refreshed: map[string]stateObject{"hcloud_server.a": srv(map[string]any{"id": 11.0})},
		recorded:  map[string]stateObject{"hcloud_server.a": srv(map[string]any{"id": 99.0})},
	}
	if st.managedServerHolds(hcloudProv, "11", always) {
		t.Fatal("a server whose recorded id differs from its live id vouched for a back-reference")
	}
}

func TestContainsNumberInsideAList(t *testing.T) {
	if !containsNumber(map[string]any{"l": []any{"s", 1.0}}) {
		t.Fatal("a number inside a list was not seen")
	}
	if containsNumber(map[string]any{"l": []any{"s", true, nil}}) {
		t.Fatal("a list of strings, bools and nulls read as holding a number")
	}
}

// clearSensitive removes every Sensitive flag from a schema block, at every depth.
func clearSensitive(b *tfjson.SchemaBlock) {
	var attr func(a *tfjson.SchemaAttribute)
	attr = func(a *tfjson.SchemaAttribute) {
		a.Sensitive = false
		if a.AttributeNestedType != nil {
			for _, na := range a.AttributeNestedType.Attributes {
				attr(na)
			}
		}
	}
	for _, a := range b.Attributes {
		attr(a)
	}
	for _, nb := range b.NestedBlocks {
		clearSensitive(nb.Block)
	}
}

// TestSchemaTraitsSkipJunk covers the fail-closed edges of the trait index that no real schema
// document reaches: an absent document, a nil provider, a nil resource schema or block, a nil
// nested block and a nil attribute.
func TestSchemaTraitsSkipJunk(t *testing.T) {
	if indexSchemaTraits(nil) != nil || indexSchemaTraits(&tfjson.ProviderSchemas{}) != nil {
		t.Fatal("no document must mean no traits")
	}
	doc := &tfjson.ProviderSchemas{Schemas: map[string]*tfjson.ProviderSchema{
		"nil": nil,
		"p": {ResourceSchemas: map[string]*tfjson.Schema{
			"nil": nil, "noblock": {},
			"t": {Block: &tfjson.SchemaBlock{
				Attributes:   map[string]*tfjson.SchemaAttribute{"a": nil, "s": {AttributeType: cty.String, Sensitive: true}},
				NestedBlocks: map[string]*tfjson.SchemaBlockType{"nil": nil, "nilblock": {}},
			}},
		}},
	}}
	idx := indexSchemaTraits(doc)
	if len(idx) != 1 {
		t.Fatalf("traits = %+v, want only p/t", idx)
	}
	if got := idx[schemaKey{provider: "p", resourceType: "t"}]; !got.sensitive || got.dynamic {
		t.Fatalf("p/t traits = %+v, want sensitive and not dynamic", got)
	}
}

// TestSchemaMarksOnlyNeedsIdenticalMarkedPaths reaches the mask comparison directly: through
// Analyze, masks that differ are sensitivityOnly's and are dismissed there first, so only a
// direct call can show this branch refuses them itself rather than relying on that order.
func TestSchemaMarksOnlyNeedsIdenticalMarkedPaths(t *testing.T) {
	v := map[string]any{"s": "v", "t": "w"}
	tr := schemaTraits{sensitive: true}
	if got, ok := schemaMarksOnly(v, v, map[string]any{"s": true}, map[string]any{"s": true}, tr, true); !ok || strings.Join(got, ",") != "s" {
		t.Fatalf("control: got (%v, %t), want ([s], true)", got, ok)
	}
	for name, masks := range map[string][2]any{
		"same size, different paths": {map[string]any{"s": true}, map[string]any{"t": true}},
		"a path gained":              {map[string]any{"s": true}, map[string]any{"s": true, "t": true}},
		"a path lost":                {map[string]any{"s": true, "t": true}, map[string]any{"s": true}},
	} {
		t.Run(name, func(t *testing.T) {
			if got, ok := schemaMarksOnly(v, v, masks[0], masks[1], tr, true); ok {
				t.Fatalf("got (%v, true), want a refusal", got)
			}
		})
	}
	if _, ok := schemaMarksOnly(map[string]any{}, map[string]any{}, true, true, tr, true); ok {
		t.Fatal("empty objects were dismissed")
	}
}
