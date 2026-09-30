// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package drift

import (
	"encoding/json"
	"strings"
	"testing"

	tfjson "github.com/hashicorp/terraform-json"
)

// testdata/hetzner_fabric_refresh.json is the refresh-only plan of a freshly provisioned hetzner
// Fabric (1 control plane + 3 workers), rebuilt from #845 run 36667774857. What is CAPTURED from
// that run's log: the seven drifted addresses, their attribute paths, and the hcloud before/after
// values (assignee_id 0 -> <server id>, assignee_type "unassigned" -> "server", apply_to [] ->
// one {server = <id>} per server), with the run's real resource ids. The same class, scaled to 1+1
// nodes, appears in the plain floor soak of 2026-08-25 (demos/proofs/hetzner/20260825T192100Z,
// drift_baseline) — no placement ran there, so it is not placement-caused.
//
// What is COMPOSED, and why: the run's log never printed plan JSON, so the talos sensitivity masks
// are reconstructed from the mechanism (sensitivityOnly's doc) and the provider's published schema
// (siderolabs/talos 0.11.0: the nested `client_key`/`key`/`secret`/`token` attributes are the
// sensitive ones). Values on those two resources are placeholders and identical on both sides —
// which IS the captured fact: OpenTofu printed "(N unchanged attributes hidden)" and no attribute.

const hetznerFixture = "hetzner_fabric_refresh.json"

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
// every dismissal naming its attributes and its reason.
func TestHetznerFabricRefreshIsInSync(t *testing.T) {
	for name, analyze := range map[string]func(*tfjson.Plan) *Posture{
		"Analyze":                 Analyze,
		"AnalyzeWithSchemas(nil)": func(p *tfjson.Plan) *Posture { return AnalyzeWithSchemas(p, nil) },
		"AnalyzeWithSchemas(unrelated)": func(p *tfjson.Plan) *Posture {
			return AnalyzeWithSchemas(p, schemasFor(gcpProvider, "google_storage_bucket", map[string]*tfjson.SchemaAttribute{"updated": {Computed: true}}))
		},
	} {
		t.Run(name, func(t *testing.T) {
			p := analyze(loadPlan(t, hetznerFixture))
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
				secrets: {ReasonSensitivityOnly, "machine_secrets.certs.etcd.key,machine_secrets.certs.k8s.key," +
					"machine_secrets.certs.k8s_aggregator.key,machine_secrets.certs.k8s_serviceaccount.key," +
					"machine_secrets.certs.os.key,machine_secrets.cluster.secret," +
					"machine_secrets.secrets.aescbc_encryption_secret,machine_secrets.secrets.bootstrap_token," +
					"machine_secrets.secrets.secretbox_encryption_secret,machine_secrets.trustdinfo.token," +
					"client_configuration.client_key"},
				kubecfg: {ReasonSensitivityOnly, "kubernetes_client_configuration.client_key"},
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
				gotAttrs := map[string]bool{}
				for _, a := range n.Attributes {
					gotAttrs[a] = true
				}
				for _, a := range strings.Split(w.attrs, ",") {
					if !gotAttrs[a] {
						t.Errorf("%s: Attributes = %v, missing %q", n.Address, n.Attributes, a)
					}
				}
				if len(n.Attributes) != len(strings.Split(w.attrs, ",")) {
					t.Errorf("%s: Attributes = %v, want exactly %s", n.Address, n.Attributes, w.attrs)
				}
			}
		})
	}
}

// TestHetznerDismissalsCarryNoValues extends Table F to the two new tiers: the posture carries
// paths, never values — the talos fixture's placeholder secrets and the primary IPs' addresses
// must not appear anywhere in the marshalled posture.
func TestHetznerDismissalsCarryNoValues(t *testing.T) {
	b, err := json.Marshal(Analyze(loadPlan(t, hetznerFixture)))
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
	t.Run("control: the fixture kubeconfig is dismissed", func(t *testing.T) {
		assertDrift(t, Analyze(onlyDrift(t, loadPlan(t, hetznerFixture), kubecfg)), false, ReasonSensitivityOnly)
	})
	cases := map[string]func(t *testing.T, rc *tfjson.ResourceChange){
		"equal values AND equal masks — unexplained, stays drift": func(_ *testing.T, rc *tfjson.ResourceChange) {
			rc.Change.AfterSensitive = rc.Change.BeforeSensitive
		},
		"no masks at all": func(_ *testing.T, rc *tfjson.ResourceChange) {
			rc.Change.BeforeSensitive, rc.Change.AfterSensitive = nil, nil
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
		"a non-update action": func(_ *testing.T, rc *tfjson.ResourceChange) {
			rc.Change.Actions = tfjson.Actions{tfjson.ActionDelete}
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			plan := onlyDrift(t, loadPlan(t, hetznerFixture), kubecfg)
			mutate(t, plan.ResourceDrift[0])
			assertDrift(t, Analyze(plan), true, "")
		})
	}
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
