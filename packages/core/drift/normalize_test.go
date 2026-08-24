// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package drift

import (
	"encoding/json"
	"strings"
	"testing"

	tfjson "github.com/hashicorp/terraform-json"
)

// A filter that cannot fail is how a detector goes quiet. Every table below holds the
// ATTRIBUTE fixed and varies only the delta shape, the declaredness, or the sensitivity,
// so a rule that keyed on an attribute name or a resource type would fail loudly rather
// than pass by coincidence.

// updateDrift builds a managed Update drift entry with attribute-level before/after.
func updateDrift(addr, typ string, before, after map[string]any) *tfjson.ResourceChange {
	return &tfjson.ResourceChange{
		Address: addr,
		Mode:    tfjson.ManagedResourceMode,
		Type:    typ,
		Change: &tfjson.Change{
			Actions: tfjson.Actions{tfjson.ActionUpdate},
			Before:  before,
			After:   after,
		},
	}
}

// planWithConfig wraps drift entries in a plan whose configuration declares the given
// attributes for the given CONFIG addresses (instance keys already stripped).
func planWithConfig(declared map[string][]string, drift ...*tfjson.ResourceChange) *tfjson.Plan {
	root := &tfjson.ConfigModule{ModuleCalls: map[string]*tfjson.ModuleCall{}}
	for addr, attrs := range declared {
		exprs := map[string]*tfjson.Expression{}
		for _, a := range attrs {
			exprs[a] = &tfjson.Expression{}
		}
		res := &tfjson.ConfigResource{Address: addr, Expressions: exprs}
		// A module-prefixed config address lives inside that module's own config block,
		// mirroring how OpenTofu emits it.
		if mod, rest, found := strings.Cut(strings.TrimPrefix(addr, "module."), "."); found && strings.HasPrefix(addr, "module.") {
			res.Address = rest
			root.ModuleCalls[mod] = &tfjson.ModuleCall{
				Module: &tfjson.ConfigModule{Resources: []*tfjson.ConfigResource{res}},
			}
			continue
		}
		root.Resources = append(root.Resources, res)
	}
	return &tfjson.Plan{ResourceDrift: drift, Config: &tfjson.Config{RootModule: root}}
}

// assertDrift is the shared verdict assertion: exactly one entry, on the expected side.
func assertDrift(t *testing.T, p *Posture, wantDrift bool, wantReason NormalizedReason) {
	t.Helper()
	if wantDrift {
		if p.Drifted != 1 || p.Normalized != 0 {
			t.Fatalf("want DRIFT, got Drifted=%d Normalized=%d (%+v)", p.Drifted, p.Normalized, p.NormalizedDetails)
		}
		return
	}
	if p.Drifted != 0 || p.Normalized != 1 {
		t.Fatalf("want dismissed, got Drifted=%d Normalized=%d (%+v)", p.Drifted, p.Normalized, p.Details)
	}
	if got := p.NormalizedDetails[0].Reason; got != wantReason {
		t.Errorf("Reason = %q, want %q", got, wantReason)
	}
}

// ── Table A — same attribute (tags), varying only the delta SHAPE ────────────────────
//
// Rows 4 and 5 are what an implementation that flattens BOTH sides to ∅ before comparing
// gets wrong. Row 5 is the security one: `tags` is where the alethia:project-id sweep
// handle lives, so losing it means losing detection of a resource being made
// un-sweepable out-of-band.

func TestTableA_TagsVaryingShape(t *testing.T) {
	const addr = "azurerm_key_vault_key.k"
	cases := []struct {
		name       string
		before     map[string]any
		after      map[string]any
		declares   []string
		wantDrift  bool
		wantReason NormalizedReason
	}{
		{"absent to empty", map[string]any{}, map[string]any{"tags": map[string]any{}}, nil, false, ReasonEmptyCollection},
		{"null to empty", map[string]any{"tags": nil}, map[string]any{"tags": map[string]any{}}, nil, false, ReasonEmptyCollection},
		{"empty to null", map[string]any{"tags": map[string]any{}}, map[string]any{"tags": nil}, nil, false, ReasonEmptyCollection},
		{"empty to populated is DRIFT — tagged out-of-band",
			map[string]any{"tags": map[string]any{}},
			map[string]any{"tags": map[string]any{"owner": "mallory"}}, nil, true, ""},
		{"populated to empty is DRIFT — sweep handle stripped",
			map[string]any{"tags": map[string]any{"alethia:project-id": "p1"}},
			map[string]any{"tags": map[string]any{}}, nil, true, ""},
		{"null to populated is DRIFT when tags IS declared",
			map[string]any{"tags": nil},
			map[string]any{"tags": map[string]any{"owner": "mallory"}}, []string{"tags"}, true, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			plan := planWithConfig(
				map[string][]string{addr: tc.declares},
				updateDrift(addr, "azurerm_key_vault_key", tc.before, tc.after))
			assertDrift(t, Analyze(plan), tc.wantDrift, tc.wantReason)
		})
	}
}

// ── Table B — same attribute (service_endpoints), varying only DECLAREDNESS ──────────
//
// Rows 1 and 2 are the same delta with opposite verdicts, separated only by the plan's
// configuration section. Rip out the config lookup and both go red.

func TestTableB_DeclarednessDiscriminates(t *testing.T) {
	const addr = "azurerm_subnet.s"
	sql := []any{"Microsoft.Sql"}
	cases := []struct {
		name       string
		before     map[string]any
		after      map[string]any
		declares   []string
		noConfig   bool
		sensitive  any
		wantDrift  bool
		wantReason NormalizedReason
	}{
		{name: "declared, null to populated is DRIFT",
			before: map[string]any{"service_endpoints": nil}, after: map[string]any{"service_endpoints": sql},
			declares: []string{"service_endpoints"}, wantDrift: true},
		{name: "undeclared, null to populated is dismissed",
			before: map[string]any{"service_endpoints": nil}, after: map[string]any{"service_endpoints": sql},
			wantDrift: false, wantReason: ReasonUndeclaredCollection},
		{name: "undeclared, null to empty is dismissed on tier 1",
			before: map[string]any{"service_endpoints": nil}, after: map[string]any{"service_endpoints": []any{}},
			wantDrift: false, wantReason: ReasonEmptyCollection},
		{name: "undeclared, populated to more populated is DRIFT — before is not null",
			before: map[string]any{"service_endpoints": sql},
			after:  map[string]any{"service_endpoints": []any{"Microsoft.Sql", "Microsoft.Storage"}},
			// Same length would descend; differing length makes the list itself the leaf.
			wantDrift: true},
		{name: "undeclared, null to SCALAR is DRIFT — collections only",
			before: map[string]any{"service_endpoints": nil}, after: map[string]any{"service_endpoints": "Microsoft.Sql"},
			wantDrift: true},
		{name: "undeclared but SENSITIVE is DRIFT",
			before: map[string]any{"service_endpoints": nil}, after: map[string]any{"service_endpoints": sql},
			sensitive: map[string]any{"service_endpoints": true}, wantDrift: true},
		{name: "no configuration section at all is DRIFT — fail closed",
			before: map[string]any{"service_endpoints": nil}, after: map[string]any{"service_endpoints": sql},
			noConfig: true, wantDrift: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rc := updateDrift(addr, "azurerm_subnet", tc.before, tc.after)
			rc.Change.AfterSensitive = tc.sensitive
			var plan *tfjson.Plan
			if tc.noConfig {
				plan = &tfjson.Plan{ResourceDrift: []*tfjson.ResourceChange{rc}}
			} else {
				plan = planWithConfig(map[string][]string{addr: tc.declares}, rc)
			}
			assertDrift(t, Analyze(plan), tc.wantDrift, tc.wantReason)
		})
	}
}

// TestConfigPresentButAddressUnresolved covers the other fail-closed branch: a plan that
// HAS configuration, for a resource that is not in it. Missing evidence must never widen
// what gets dismissed.
func TestConfigPresentButAddressUnresolved(t *testing.T) {
	rc := updateDrift("azurerm_subnet.orphan", "azurerm_subnet",
		map[string]any{"service_endpoints": nil},
		map[string]any{"service_endpoints": []any{"Microsoft.Sql"}})
	plan := planWithConfig(map[string][]string{"azurerm_subnet.other": {"name"}}, rc)
	assertDrift(t, Analyze(plan), true, "")
}

// ── Table C — the VNet, exactly as the failing Azure run produced it ─────────────────
//
// The dismissed row also pins tfaddr.ConfigAddress from the CALLER's side: a
// truncation at the first '[' yields "module.vnet", misses the configuration, fails
// closed, and this row goes red. That is the behaviour we want — the address bug
// (#2361, which verify carried for real) caught by a unit test rather than by a
// customer. The normaliser's own table is TestConfigAddress in packages/core/tfaddr.

func TestTableC_VirtualNetworkSubnetHydration(t *testing.T) {
	const addr = "module.vnet[0].azurerm_virtual_network.this"
	const cfgAddr = "module.vnet.azurerm_virtual_network.this"
	subnet := func(names ...string) []any {
		out := make([]any, 0, len(names))
		for _, n := range names {
			out = append(out, map[string]any{"name": n, "address_prefixes": []any{"10.0.0.0/20"}})
		}
		return out
	}
	four := subnet("private", "public", "db", "appgw")

	cases := []struct {
		name      string
		before    map[string]any
		after     map[string]any
		wantDrift bool
	}{
		{"null to four subnets is dismissed — the deprecated inline attribute hydrating",
			map[string]any{"subnet": nil}, map[string]any{"subnet": four}, false},
		{"four to three is DRIFT — a subnet vanished",
			map[string]any{"subnet": four}, map[string]any{"subnet": subnet("private", "public", "db")}, true},
		{"four to four with one differing is DRIFT",
			map[string]any{"subnet": four}, map[string]any{"subnet": subnet("private", "public", "db", "RENAMED")}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			plan := planWithConfig(
				map[string][]string{cfgAddr: {"name", "location", "resource_group_name", "address_space", "tags"}},
				updateDrift(addr, "azurerm_virtual_network", tc.before, tc.after))
			assertDrift(t, Analyze(plan), tc.wantDrift, ReasonUndeclaredCollection)
		})
	}
}

// ── Table D — mixed and structural ───────────────────────────────────────────────────

// TestTableD_OneRealDeltaKeepsTheWholeResource proves resources are never partially
// forgiven: a benign delta alongside a real one must not launder the real one.
func TestTableD_OneRealDeltaKeepsTheWholeResource(t *testing.T) {
	rc := updateDrift("azurerm_key_vault.v", "azurerm_key_vault",
		map[string]any{"tags": nil, "sku_name": "standard"},
		map[string]any{"tags": map[string]any{}, "sku_name": "premium"})
	p := Analyze(planWithConfig(map[string][]string{"azurerm_key_vault.v": {"sku_name"}}, rc))
	assertDrift(t, p, true, "")
	if p.Details[0].Kind != KindModified {
		t.Errorf("Kind = %q, want %q", p.Details[0].Kind, KindModified)
	}
	if len(p.NormalizedDetails) != 0 {
		t.Errorf("a drifted resource must not also appear as normalized: %+v", p.NormalizedDetails)
	}
}

// TestTableD_NestedBlockSiblingsClassifiedIndependently covers the AKS shape from the
// real run: default_node_pool is a list-of-one object, so the walk descends by index and
// then by key, and a real sibling change inside the block still surfaces.
func TestTableD_NestedBlockSiblings(t *testing.T) {
	pool := func(extra map[string]any) []any {
		m := map[string]any{"name": "default"}
		for k, v := range extra {
			m[k] = v
		}
		return []any{m}
	}
	t.Run("benign nested hydration is dismissed", func(t *testing.T) {
		rc := updateDrift("module.aks[0].azurerm_kubernetes_cluster.this", "azurerm_kubernetes_cluster",
			map[string]any{"default_node_pool": pool(map[string]any{"tags": nil, "zones": nil})},
			map[string]any{"default_node_pool": pool(map[string]any{"tags": map[string]any{}, "zones": []any{}})})
		p := Analyze(planWithConfig(nil, rc))
		assertDrift(t, p, false, ReasonEmptyCollection)
		got := p.NormalizedDetails[0].Attributes
		want := []string{"default_node_pool[0].tags", "default_node_pool[0].zones"}
		if strings.Join(got, ",") != strings.Join(want, ",") {
			t.Errorf("attribute paths = %v, want %v", got, want)
		}
	})
	t.Run("a real nested change is DRIFT", func(t *testing.T) {
		rc := updateDrift("module.aks[0].azurerm_kubernetes_cluster.this", "azurerm_kubernetes_cluster",
			map[string]any{"default_node_pool": pool(map[string]any{"tags": nil, "node_count": 3.0})},
			map[string]any{"default_node_pool": pool(map[string]any{"tags": map[string]any{}, "node_count": 1.0})})
		assertDrift(t, Analyze(planWithConfig(nil, rc)), true, "")
	})
}

// TestTableD_NonUpdateActionsAreNeverDismissible pins the structural guard: a resource
// deleted or recreated out-of-band is drift regardless of how benign its diff looks.
func TestTableD_NonUpdateActionsAreNeverDismissible(t *testing.T) {
	for _, tc := range []struct {
		name string
		acts tfjson.Actions
		want Kind
	}{
		{"delete", tfjson.Actions{tfjson.ActionDelete}, KindDeleted},
		{"create", tfjson.Actions{tfjson.ActionCreate}, KindOther},
		{"replace", tfjson.Actions{tfjson.ActionDelete, tfjson.ActionCreate}, KindOther},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rc := updateDrift("aws_s3_bucket.b", "aws_s3_bucket",
				map[string]any{"tags": nil}, map[string]any{"tags": map[string]any{}})
			rc.Change.Actions = tc.acts
			p := Analyze(planWithConfig(nil, rc))
			assertDrift(t, p, true, "")
			if p.Details[0].Kind != tc.want {
				t.Errorf("Kind = %q, want %q", p.Details[0].Kind, tc.want)
			}
		})
	}
}

// TestTableD_UnreadableDiffStaysDrift covers the guard that keeps a change carrying no
// usable before/after from being dismissed vacuously — the failure mode where a filter
// silences everything it cannot read.
func TestTableD_UnreadableDiffStaysDrift(t *testing.T) {
	cases := map[string]*tfjson.Change{
		"no before/after at all": {Actions: tfjson.Actions{tfjson.ActionUpdate}},
		"before is a string":     {Actions: tfjson.Actions{tfjson.ActionUpdate}, Before: "x", After: map[string]any{}},
		"after is a string":      {Actions: tfjson.Actions{tfjson.ActionUpdate}, Before: map[string]any{}, After: "x"},
		"identical objects":      {Actions: tfjson.Actions{tfjson.ActionUpdate}, Before: map[string]any{"a": "b"}, After: map[string]any{"a": "b"}},
	}
	for name, ch := range cases {
		t.Run(name, func(t *testing.T) {
			rc := &tfjson.ResourceChange{Address: "a.a", Mode: tfjson.ManagedResourceMode, Type: "a", Change: ch}
			assertDrift(t, Analyze(planWithConfig(nil, rc)), true, "")
		})
	}
}

// ── Table E — cloud parity ───────────────────────────────────────────────────────────

// TestTableE_CloudParity runs the same shapes under every provider we ship. Any
// azurerm-specific shortcut fails here. This is the mechanical enforcement of the
// repo's cloud-parity rule.
func TestTableE_CloudParity(t *testing.T) {
	for _, typ := range []string{
		"aws_s3_bucket", "google_compute_subnetwork", "hcloud_server",
		"alicloud_vpc", "azurerm_subnet",
	} {
		t.Run(typ, func(t *testing.T) {
			addr := typ + ".x"
			dismissed := updateDrift(addr, typ,
				map[string]any{"tags": nil}, map[string]any{"tags": map[string]any{}})
			assertDrift(t, Analyze(planWithConfig(nil, dismissed)), false, ReasonEmptyCollection)

			real := updateDrift(addr, typ,
				map[string]any{"tags": map[string]any{"alethia:project-id": "p1"}},
				map[string]any{"tags": map[string]any{}})
			assertDrift(t, Analyze(planWithConfig(nil, real)), true, "")
		})
	}
}

// ── Table F — the secret-retention proof ─────────────────────────────────────────────

// TestTableF_NoAttributeValuesEverLeak is a durable guard on the boundary that makes
// this package safe to log. A later "let's include the before value for debuggability"
// edit is exactly how a redaction rule dies, and this test is what stops it.
func TestTableF_NoAttributeValuesEverLeak(t *testing.T) {
	const sentinel = "S3CRET-DO-NOT-LEAK"
	rc := updateDrift("azurerm_key_vault.v", "azurerm_key_vault",
		map[string]any{"tags": nil, sentinel: nil},
		map[string]any{"tags": map[string]any{}, sentinel: map[string]any{}})
	// The sentinel also appears as a VALUE on an unrelated, unchanged attribute.
	rc.Change.Before.(map[string]any)["note"] = sentinel
	rc.Change.After.(map[string]any)["note"] = sentinel

	p := Analyze(planWithConfig(nil, rc))
	assertDrift(t, p, false, ReasonEmptyCollection)

	b, err := json.Marshal(p)
	if err != nil {
		t.Fatalf("marshal posture: %v", err)
	}
	// The attribute PATH must survive — it is provider-schema data and it is the audit
	// record. The path here happens to equal the sentinel, so assert on the structure.
	var found bool
	for _, a := range p.NormalizedDetails[0].Attributes {
		if a == sentinel {
			found = true
		}
	}
	if !found {
		t.Errorf("attribute paths must survive into the audit record, got %v", p.NormalizedDetails[0].Attributes)
	}
	// ...but the VALUE must not. "note" is the only place the sentinel exists as a value,
	// and it must appear nowhere in the marshalled posture.
	if strings.Contains(string(b), `"note"`) {
		t.Errorf("an attribute VALUE leaked into the posture: %s", b)
	}
}

// ── Table G — regression pin ─────────────────────────────────────────────────────────

// TestTableG_ExistingFixtureUnchanged pins the two hand-written fixtures. drifted.json's
// `ingress: [] -> [{from_port: 22}]` is already a perfect tier-1 discriminator: someone
// opened port 22 out-of-band, the before side is empty, the after side is populated, and
// the classifier must leave it alone.
func TestTableG_ExistingFixtureUnchanged(t *testing.T) {
	p := Analyze(loadPlan(t, "drifted.json"))
	if p.Drifted != 2 || p.Normalized != 0 {
		t.Fatalf("Drifted=%d Normalized=%d, want 2/0 — the classifier must not touch this fixture", p.Drifted, p.Normalized)
	}
	if got, want := p.Summary(), "drift: 2 resource(s) (1 modified, 1 deleted)"; got != want {
		t.Errorf("Summary() = %q, want %q (byte-identical when nothing was dismissed)", got, want)
	}
}

// TestSummaryCarriesNormalizedCount covers the Normalized>0 branch on both the in-sync
// and drifted sides of Summary.
func TestSummaryCarriesNormalizedCount(t *testing.T) {
	benign := updateDrift("a.a", "a", map[string]any{"tags": nil}, map[string]any{"tags": map[string]any{}})
	t.Run("in sync", func(t *testing.T) {
		p := Analyze(planWithConfig(nil, benign))
		if got, want := p.Summary(), "drift: in sync [+1 normalized]"; got != want {
			t.Errorf("Summary() = %q, want %q", got, want)
		}
	})
	t.Run("alongside real drift", func(t *testing.T) {
		real := updateDrift("b.b", "b",
			map[string]any{"tags": map[string]any{"k": "v"}}, map[string]any{"tags": map[string]any{}})
		p := Analyze(planWithConfig(nil, benign, real))
		if got, want := p.Summary(), "drift: 1 resource(s) (1 modified) [+1 normalized]"; got != want {
			t.Errorf("Summary() = %q, want %q", got, want)
		}
	})
}

// TestSensitivityMaskShapes covers every mask shape. The resource is always PRESENT in
// the configuration (declaring an unrelated attribute), so the config-aware tier is live
// and the mask is genuinely what decides each verdict — otherwise these would pass
// vacuously on the fail-closed branch and prove nothing about sensitivity at all.
func TestSensitivityMaskShapes(t *testing.T) {
	const addr = "a.a"
	declared := map[string][]string{addr: {"unrelated"}}
	cases := []struct {
		name       string
		beforeSens any
		afterSens  any
		wantDrift  bool
		wantReason NormalizedReason
	}{
		{"no mask at all is dismissed", nil, nil, false, ReasonUndeclaredCollection},
		{"after-side true marks", nil, map[string]any{"conf": true}, true, ""},
		{"before-side true marks", map[string]any{"conf": true}, nil, true, ""},
		{"nested mask marks — something beneath is sensitive", nil, map[string]any{"conf": map[string]any{"inner": true}}, true, ""},
		{"non-empty list mask marks", nil, map[string]any{"conf": []any{true}}, true, ""},
		{"explicit false does not mark", nil, map[string]any{"conf": false}, false, ReasonUndeclaredCollection},
		{"empty map mask does not mark", nil, map[string]any{"conf": map[string]any{}}, false, ReasonUndeclaredCollection},
		{"empty list mask does not mark", nil, map[string]any{"conf": []any{}}, false, ReasonUndeclaredCollection},
		{"mask for another attribute is irrelevant", nil, map[string]any{"other": true}, false, ReasonUndeclaredCollection},
		{"mask that is not an object is ignored", nil, "not-a-mask", false, ReasonUndeclaredCollection},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rc := updateDrift(addr, "a",
				map[string]any{"conf": nil}, map[string]any{"conf": []any{"x"}})
			rc.Change.BeforeSensitive = tc.beforeSens
			rc.Change.AfterSensitive = tc.afterSens
			assertDrift(t, Analyze(planWithConfig(declared, rc)), tc.wantDrift, tc.wantReason)
		})
	}
}

// TestTier1IgnoresSensitivity pins a deliberate asymmetry: an EMPTY collection has no
// content to protect, so marking it sensitive must not resurrect it as drift. Otherwise
// a sensitive-but-unset attribute would be reported as drifted on every scan, forever.
func TestTier1IgnoresSensitivity(t *testing.T) {
	rc := updateDrift("a.a", "a",
		map[string]any{"conf": nil}, map[string]any{"conf": []any{}})
	rc.Change.AfterSensitive = map[string]any{"conf": true}
	assertDrift(t, Analyze(planWithConfig(map[string][]string{"a.a": {"conf"}}, rc)), false, ReasonEmptyCollection)
}

// TestNestedDepthIsNotConfigAware pins the depth-0 narrowing: a nested undeclared
// collection materialising from null is NOT dismissed, because nested declaredness is
// not something this classifier attempts to judge.
// The resource IS in the configuration, so the config-aware tier is live and DEPTH is
// the only thing standing between this and a dismissal.
func TestNestedDepthIsNotConfigAware(t *testing.T) {
	declared := map[string][]string{"a.a": {"unrelated"}}
	t.Run("nested undeclared collection stays drift", func(t *testing.T) {
		rc := updateDrift("a.a", "a",
			map[string]any{"block": []any{map[string]any{"list": nil}}},
			map[string]any{"block": []any{map[string]any{"list": []any{"x"}}}})
		assertDrift(t, Analyze(planWithConfig(declared, rc)), true, "")
	})
	t.Run("the same delta at depth 0 is dismissed", func(t *testing.T) {
		rc := updateDrift("a.a", "a",
			map[string]any{"list": nil}, map[string]any{"list": []any{"x"}})
		assertDrift(t, Analyze(planWithConfig(declared, rc)), false, ReasonUndeclaredCollection)
	})
}

// TestNilConfigModuleBranches covers indexConfig's guards: a plan with no config, a
// config with a nil root module, and a module call carrying a nil module.
func TestNilConfigModuleBranches(t *testing.T) {
	rc := updateDrift("a.a", "a", map[string]any{"t": nil}, map[string]any{"t": map[string]any{}})
	for name, plan := range map[string]*tfjson.Plan{
		"no config":       {ResourceDrift: []*tfjson.ResourceChange{rc}},
		"nil root module": {ResourceDrift: []*tfjson.ResourceChange{rc}, Config: &tfjson.Config{}},
		"nil module call": {ResourceDrift: []*tfjson.ResourceChange{rc}, Config: &tfjson.Config{RootModule: &tfjson.ConfigModule{
			ModuleCalls: map[string]*tfjson.ModuleCall{"m": nil},
			Resources:   []*tfjson.ConfigResource{nil},
		}}},
		// A module call that EXISTS but carries no module block — the walk must stop at it
		// rather than dereference nil.
		"module call with a nil module": {ResourceDrift: []*tfjson.ResourceChange{rc}, Config: &tfjson.Config{RootModule: &tfjson.ConfigModule{
			ModuleCalls: map[string]*tfjson.ModuleCall{"m": {Module: nil}},
		}}},
	} {
		t.Run(name, func(t *testing.T) {
			// Tier 1 still applies with no configuration — it never needed it.
			assertDrift(t, Analyze(plan), false, ReasonEmptyCollection)
		})
	}
}

// ── The real capture ─────────────────────────────────────────────────────────────────

// TestAzureRefreshNoiseFixture is the CI failure reproduced as a unit test. The fixture
// is reconstructed from the drift block of the azure floor run that reported 9 of 32
// resources drifted minutes after a clean apply. It is what lets this fix land without a
// cloud round-trip.
func TestAzureRefreshNoiseFixture(t *testing.T) {
	p := Analyze(loadPlan(t, "azure_refresh_noise.json"))
	if !p.InSync || p.Drifted != 0 {
		t.Fatalf("a clean apply must read as in-sync: InSync=%v Drifted=%d details=%+v", p.InSync, p.Drifted, p.Details)
	}
	if p.Normalized != 9 {
		t.Fatalf("Normalized = %d, want 9 — every delta examined and accounted for", p.Normalized)
	}
	want := map[string]NormalizedReason{
		"azurerm_key_vault_key.aks_secrets[0]":               ReasonEmptyCollection,
		"azurerm_user_assigned_identity.external_dns[0]":     ReasonEmptyCollection,
		"azurerm_user_assigned_identity.external_secrets[0]": ReasonEmptyCollection,
		"module.aks[0].azurerm_kubernetes_cluster.this":      ReasonEmptyCollection,
		"module.vnet[0].azurerm_subnet.application_gateway":  ReasonEmptyCollection,
		"module.vnet[0].azurerm_subnet.database":             ReasonEmptyCollection,
		"module.vnet[0].azurerm_subnet.private":              ReasonEmptyCollection,
		"module.vnet[0].azurerm_subnet.public":               ReasonEmptyCollection,
		"module.vnet[0].azurerm_virtual_network.this":        ReasonUndeclaredCollection,
	}
	for _, n := range p.NormalizedDetails {
		wantReason, ok := want[n.Address]
		if !ok {
			t.Errorf("unexpected normalized address %q", n.Address)
			continue
		}
		if n.Reason != wantReason {
			t.Errorf("%s: Reason = %q, want %q", n.Address, n.Reason, wantReason)
		}
		if len(n.Attributes) == 0 {
			t.Errorf("%s: dismissed with no attribute paths — the audit record is empty", n.Address)
		}
		delete(want, n.Address)
	}
	for addr := range want {
		t.Errorf("expected normalized address missing from the posture: %q", addr)
	}
}
