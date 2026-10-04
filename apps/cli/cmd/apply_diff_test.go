// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/manifest"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// ── item 1: the diff ──────────────────────────────────────────────────────────────────────

func TestDiffFields(t *testing.T) {
	for name, tc := range map[string]struct {
		declared, current map[string]any
		want              []FieldChange
	}{
		"equal string": {
			map[string]any{"engine": "postgres"}, map[string]any{"engine": "postgres"}, nil,
		},
		"changed string": {
			map[string]any{"instance_class": "db.t3.small"}, map[string]any{"instance_class": "db.t3.micro"},
			[]FieldChange{{Field: "instance_class", From: "db.t3.micro", To: "db.t3.small"}},
		},
		"an omitted field is never a change": {
			map[string]any{"engine": "postgres"}, map[string]any{"engine": "postgres", "port": float64(5432), "iam_auth": true}, nil,
		},
		"an empty declaration changes nothing": {
			map[string]any{}, map[string]any{"port": float64(5432)}, nil,
		},
		"YAML int equals JSON float": {
			map[string]any{"max_capacity": 2}, map[string]any{"max_capacity": float64(2)}, nil,
		},
		"2 equals 2.0": {
			map[string]any{"max_capacity": 2.0}, map[string]any{"max_capacity": 2}, nil,
		},
		"int64 and json.Number by value": {
			map[string]any{"port": int64(5432)}, map[string]any{"port": json.Number("5432")}, nil,
		},
		"a different number": {
			map[string]any{"max_capacity": 4}, map[string]any{"max_capacity": float64(2)},
			[]FieldChange{{Field: "max_capacity", From: float64(2), To: 4}},
		},
		"a field the server does not hold": {
			map[string]any{"node_max_size": 4}, map[string]any{},
			[]FieldChange{{Field: "node_max_size", From: nil, To: 4}},
		},
		"null equals absent": {
			map[string]any{"zone_id": nil}, map[string]any{}, nil,
		},
		"lists compare structurally": {
			map[string]any{"instance_types": []any{"t3.small", 2}}, map[string]any{"instance_types": []any{"t3.small", float64(2)}}, nil,
		},
		"list order matters": {
			map[string]any{"cors_origins": []any{"a", "b"}}, map[string]any{"cors_origins": []any{"b", "a"}},
			[]FieldChange{{Field: "cors_origins", From: []any{"b", "a"}, To: []any{"a", "b"}}},
		},
		"typed string slice equals decoded list": {
			map[string]any{"cors_origins": []string{"a"}}, map[string]any{"cors_origins": []any{"a"}}, nil,
		},
		"maps compare structurally, YAML keys too": {
			map[string]any{"node_size": map[any]any{"vcpu": 4, "memory_gb": 16}},
			map[string]any{"node_size": map[string]any{"memory_gb": float64(16), "vcpu": float64(4)}}, nil,
		},
		"a nested map difference": {
			map[string]any{"node_size": map[string]any{"vcpu": 8}}, map[string]any{"node_size": map[string]any{"vcpu": float64(4)}},
			[]FieldChange{{Field: "node_size", From: map[string]any{"vcpu": float64(4)}, To: map[string]any{"vcpu": 8}}},
		},
		"bool vs string is a change": {
			map[string]any{"multi_az": true}, map[string]any{"multi_az": "true"},
			[]FieldChange{{Field: "multi_az", From: "true", To: true}},
		},
		"sorted by field": {
			map[string]any{"b": 1, "a": 1, "c": 1}, map[string]any{"b": 2, "a": 2, "c": 1},
			[]FieldChange{{Field: "a", From: 2, To: 1}, {Field: "b", From: 2, To: 1}},
		},
	} {
		t.Run(name, func(t *testing.T) {
			got := diffFields(tc.declared, tc.current)
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("diffFields = %#v, want %#v", got, tc.want)
			}
		})
	}
}

func TestFormatFieldValue(t *testing.T) {
	for in, want := range map[string]struct {
		v    any
		want string
	}{
		"nil":    {nil, "(unset)"},
		"string": {"db.t3.small", "db.t3.small"},
		"empty":  {"", `""`},
		"int":    {2, "2"},
		"float":  {2.5, "2.5"},
		"bool":   {true, "true"},
		"list":   {[]any{"a", 1}, `["a",1]`},
		"map":    {map[any]any{"vcpu": 4}, `{"vcpu":4}`},
	} {
		if got := formatFieldValue(want.v); got != want.want {
			t.Errorf("%s: formatFieldValue(%v) = %q, want %q", in, want.v, got, want.want)
		}
	}
}

// ── a fake control plane, at the applyClient seam ─────────────────────────────────────────

type diffCall struct {
	Method, Kind, Name, Env string
	Fields                  map[string]any
}

// diffFake serves one existing project "web" (p1) with the environments and components it is
// given, and records every write. It embeds applyClient so a call it does not expect panics.
type diffFake struct {
	applyClient
	envs      []api.Environment
	comps     map[string][]api.Component // by environment name
	calls     []diffCall
	refuse    map[string]error // UpdateComponent errors, by "env kind/name"
	jobs      []string         // environment ids a DEPLOY was queued for
	listCalls int
}

func (f *diffFake) GetConfigurations() ([]types.ConfigurationSummary, error) {
	return []types.ConfigurationSummary{{ID: "p1", ProjectName: "web"}}, nil
}
func (f *diffFake) ListEnvironments(string) ([]api.Environment, error) {
	f.listCalls++
	return f.envs, nil
}
func (f *diffFake) ListComponents(_, _, env string) ([]api.Component, error) {
	return f.comps[env], nil
}
func (f *diffFake) AddComponent(_, kind, name, env string, fields map[string]interface{}) (*api.Component, error) {
	f.calls = append(f.calls, diffCall{"add", kind, name, env, fields})
	return &api.Component{Kind: kind, Name: name}, nil
}
func (f *diffFake) UpdateComponent(_, kind, name, env string, fields map[string]interface{}) (*api.Component, error) {
	f.calls = append(f.calls, diffCall{"update", kind, name, env, fields})
	if err := f.refuse[env+" "+kind+"/"+name]; err != nil {
		return nil, err
	}
	return &api.Component{Kind: kind, Name: name}, nil
}
func (f *diffFake) QueueJobWithParams(p api.QueueJobParams) (*api.ProvisionJob, error) {
	f.jobs = append(f.jobs, p.EnvironmentID)
	return &api.ProvisionJob{ID: "j-" + p.EnvironmentID, Status: "QUEUED"}, nil
}

// diffManifest parses a manifest the way planFromFile does, without the schema check.
func diffManifest(t *testing.T, body string) *manifest.Manifest {
	t.Helper()
	m, err := manifest.Parse([]byte(body))
	if err != nil {
		t.Fatal(err)
	}
	m.Normalize()
	return m
}

const diffTwoEnvManifest = `project: web
cloud:
  region: eu-west-1
environments:
  - name: prod
    stage: production
    components:
      cluster:
        node_max_size: 4
      databases:
        - name: orders
          engine: postgres
          max_capacity: 8
        - name: carts
          engine: postgres
  - name: dev
    stage: development
    placement: namespace
    components:
      databases:
        - name: orders
          max_capacity: 2
`

// diffTwoEnvFake is the server side of diffTwoEnvManifest: the cluster already matches, prod's
// orders runs at 4 (the file says 8), carts matches, and dev's orders runs at 1 (the file says 2).
func diffTwoEnvFake() *diffFake {
	return &diffFake{
		envs: []api.Environment{
			{ID: "e1", Name: "prod", Stage: "production", PlacementMode: "dedicated"},
			{ID: "e2", Name: "dev", Stage: "development", PlacementMode: "namespace"},
		},
		comps: map[string][]api.Component{
			"prod": {
				{ID: "c0", Kind: "cluster", Name: "cluster", Config: map[string]any{"node_max_size": float64(4), "node_min_size": float64(1)}},
				{ID: "c1", Kind: "databases", Name: "orders", Config: map[string]any{"engine": "postgres", "max_capacity": float64(4), "port": float64(5432)}},
				{ID: "c2", Kind: "databases", Name: "carts", Config: map[string]any{"engine": "postgres", "max_capacity": float64(4)}},
			},
			"dev": {
				{ID: "c3", Kind: "databases", Name: "orders", Config: map[string]any{"engine": "postgres", "max_capacity": float64(1)}},
			},
		},
	}
}

// ── item 2: an unchanged singleton sends nothing ──────────────────────────────────────────

func TestComputePlan_AMatchingSingletonIsUnchangedAndApplySendsNothing(t *testing.T) {
	f := &diffFake{
		envs: []api.Environment{{ID: "e1", Name: "prod", Stage: "production", PlacementMode: "dedicated"}},
		comps: map[string][]api.Component{"prod": {
			{ID: "c0", Kind: "cluster", Name: "cluster", Config: map[string]any{"node_max_size": float64(4), "node_min_size": float64(1)}},
			{ID: "c1", Kind: "databases", Name: "orders", Config: map[string]any{"engine": "postgres", "port": float64(5432)}},
		}},
	}
	m := diffManifest(t, "project: web\ncloud:\n  region: eu-west-1\nenvironments:\n  - name: prod\n    stage: production\n    components:\n      cluster:\n        node_max_size: 4\n      databases:\n        - name: orders\n          engine: postgres\n")
	plan, err := computePlan(f, m)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range plan.Environments[0].Components {
		if c.Action != ActionUnchanged || len(c.Changes) != 0 {
			t.Errorf("%s: action %s changes %v, want unchanged with no diff", componentLabel(c), c.Action, c.Changes)
		}
	}
	if _, err := executeApply(f, &bytes.Buffer{}, ui.FormatTable, plan, "", false); err != nil {
		t.Fatal(err)
	}
	if len(f.calls) != 0 {
		t.Errorf("apply wrote components that already match: %+v", f.calls)
	}
	// Nothing was created, so the environment ids already in the plan are used as they are.
	if f.listCalls != 1 {
		t.Errorf("environments listed %d times, want once (the plan's read)", f.listCalls)
	}
}

func TestComputePlan_ADifferingSingletonIsAnUpdateWithItsDiff(t *testing.T) {
	f := &diffFake{
		envs: []api.Environment{{ID: "e1", Name: "prod", Stage: "production", PlacementMode: "dedicated"}},
		comps: map[string][]api.Component{"prod": {
			{ID: "c0", Kind: "cluster", Name: "cluster", Config: map[string]any{"node_max_size": float64(3)}},
		}},
	}
	m := diffManifest(t, "project: web\ncloud:\n  region: eu-west-1\nenvironments:\n  - name: prod\n    stage: production\n    components:\n      cluster:\n        node_max_size: 4\n")
	plan, err := computePlan(f, m)
	if err != nil {
		t.Fatal(err)
	}
	got := plan.Environments[0].Components[0]
	want := []FieldChange{{Field: "node_max_size", From: float64(3), To: 4}}
	if got.Action != ActionUpdate || !reflect.DeepEqual(got.Changes, want) {
		t.Errorf("got %s %+v, want update %+v", got.Action, got.Changes, want)
	}
	if _, err := executeApply(f, &bytes.Buffer{}, ui.FormatTable, plan, "", false); err != nil {
		t.Fatal(err)
	}
	// A singleton is upserted through the add route — there is no name to PATCH.
	if len(f.calls) != 1 || f.calls[0].Method != "add" || f.calls[0].Kind != "cluster" {
		t.Errorf("calls %+v, want one upsert of the cluster", f.calls)
	}
}

func TestComputePlan_CloudIdentityIsComparedFromItsOwnWireField(t *testing.T) {
	id := "ci-1"
	f := &diffFake{
		envs: []api.Environment{{ID: "e1", Name: "prod", Stage: "production", PlacementMode: "dedicated"}},
		comps: map[string][]api.Component{"prod": {
			{ID: "c1", Kind: "databases", Name: "orders", CloudIdentityID: &id, Config: map[string]any{}},
		}},
	}
	m := diffManifest(t, "project: web\ncloud:\n  region: eu-west-1\nenvironments:\n  - name: prod\n    stage: production\n    components:\n      databases:\n        - name: orders\n          cloud_identity_id: ci-1\n")
	plan, err := computePlan(f, m)
	if err != nil {
		t.Fatal(err)
	}
	if c := plan.Environments[0].Components[0]; c.Action != ActionUnchanged {
		t.Errorf("a matching cloud_identity_id planned as %s %+v", c.Action, c.Changes)
	}
}

// ── item 3: the diff is shown, as text and as JSON ────────────────────────────────────────

func TestRenderPlan_GoldenFieldDiff(t *testing.T) {
	f := diffTwoEnvFake()
	plan, err := computePlan(f, diffManifest(t, diffTwoEnvManifest))
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	renderPlan(&out, plan)
	want := `▸ Reading alethia.yaml · web · eu-west-1
  prod  dedicated  = environment  = cluster  ~ databases/orders  = databases/carts
    ~ databases/orders  max_capacity: 4 → 8
  dev   namespace  = environment  ~ databases/orders
    ~ databases/orders  max_capacity: 1 → 2
  0 projects to create · 0 environments · 0 components · 2 components to update
`
	if got := out.String(); got != want {
		t.Errorf("plan text:\n%s\nwant:\n%s", got, want)
	}
}

func TestPlanJSON_CarriesTheChangesArray(t *testing.T) {
	plan, err := computePlan(diffTwoEnvFake(), diffManifest(t, diffTwoEnvManifest))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(plan)
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Environments []struct {
			Name       string `json:"name"`
			Components []struct {
				Kind    string           `json:"kind"`
				Name    string           `json:"name"`
				Action  string           `json:"action"`
				Changes []map[string]any `json:"changes"`
			} `json:"components"`
		} `json:"environments"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	orders := doc.Environments[0].Components[1]
	if orders.Name != "orders" || orders.Action != "update" {
		t.Fatalf("prod orders = %+v", orders)
	}
	want := []map[string]any{{"field": "max_capacity", "from": float64(4), "to": float64(8)}}
	if !reflect.DeepEqual(orders.Changes, want) {
		t.Errorf("changes = %v, want %v", orders.Changes, want)
	}
	// An unchanged component carries no `changes` key at all.
	if !strings.Contains(string(raw), `"action":"unchanged"`) {
		t.Fatalf("no unchanged component in %s", raw)
	}
	var loose map[string]any
	_ = json.Unmarshal(raw, &loose)
	envs, _ := loose["environments"].([]any)
	prod, _ := envs[0].(map[string]any)
	comps, _ := prod["components"].([]any)
	cluster, _ := comps[0].(map[string]any)
	if _, has := cluster["changes"]; has {
		t.Errorf("an unchanged component carries `changes`: %v", cluster)
	}
}

// ── items 5 and 6: apply PATCHes only what changed, and a refusal is per component ────────

func TestExecuteApply_PatchesOnlyTheChangedFields(t *testing.T) {
	f := diffTwoEnvFake()
	plan, err := computePlan(f, diffManifest(t, diffTwoEnvManifest))
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	result, err := executeApply(f, &out, ui.FormatTable, plan, "", false)
	if err != nil {
		t.Fatalf("executeApply: %v", err)
	}
	want := []diffCall{
		{"update", "databases", "orders", "prod", map[string]any{"max_capacity": 8}},
		{"update", "databases", "orders", "dev", map[string]any{"max_capacity": 2}},
	}
	if !reflect.DeepEqual(f.calls, want) {
		t.Errorf("calls = %+v, want %+v", f.calls, want)
	}
	if len(result.Errors) != 0 || !reflect.DeepEqual(f.jobs, []string{"e1", "e2"}) {
		t.Errorf("errors %v, deploys %v", result.Errors, f.jobs)
	}
	if !strings.Contains(out.String(), "updated databases/orders in prod") {
		t.Errorf("progress:\n%s", out.String())
	}
}

func TestExecuteApply_ARefusedUpdateIsThatComponentsErrorAndOtherEnvironmentsCarryOn(t *testing.T) {
	f := diffTwoEnvFake()
	f.refuse = map[string]error{"prod databases/orders": errors.New("max_capacity cannot be changed on a live database")}
	plan, err := computePlan(f, diffManifest(t, diffTwoEnvManifest))
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	result, err := executeApply(f, &out, ui.FormatTable, plan, "", false)
	if err == nil || !strings.Contains(err.Error(), "prod databases/orders: max_capacity cannot be changed") {
		t.Fatalf("err = %v, want the refusal named by environment and component", err)
	}
	if result == nil {
		t.Fatal("a refusal must still return the result")
	}
	wantErrs := []ComponentError{{Environment: "prod", Component: "databases/orders", Error: "max_capacity cannot be changed on a live database"}}
	if !reflect.DeepEqual(result.Errors, wantErrs) {
		t.Errorf("errors = %+v, want %+v", result.Errors, wantErrs)
	}
	// dev was still updated AND deployed; prod, whose change was refused, was not deployed.
	if len(f.calls) != 2 || f.calls[1].Env != "dev" {
		t.Errorf("dev was not updated after prod's refusal: %+v", f.calls)
	}
	if !reflect.DeepEqual(f.jobs, []string{"e2"}) {
		t.Errorf("deploys = %v, want only dev (e2)", f.jobs)
	}
	if !strings.Contains(out.String(), "prod not deployed") {
		t.Errorf("the held-back deploy is not said:\n%s", out.String())
	}
}

// ── the comparison's edges ────────────────────────────────────────────────────────────────

// TestValuesEqual_EveryNumberKindAndTheFallbacks: every Go number kind compares by value with
// JSON's float64; a typed value with no case of its own compares by its JSON meaning; and a value
// JSON cannot represent equals nothing else.
func TestValuesEqual_EveryNumberKindAndTheFallbacks(t *testing.T) {
	two := float64(2)
	for name, v := range map[string]any{
		"int8": int8(2), "int16": int16(2), "int32": int32(2), "int64": int64(2),
		"uint": uint(2), "uint8": uint8(2), "uint16": uint16(2), "uint32": uint32(2), "uint64": uint64(2),
		"float32": float32(2), "json.Number": json.Number("2"),
	} {
		if !valuesEqual(v, two) {
			t.Errorf("%s 2 does not equal float64 2", name)
		}
	}
	if !valuesEqual(json.Number("not-a-number"), "not-a-number") {
		t.Error("a json.Number that is not a float compares as its text")
	}
	type size struct {
		VCPU int `json:"vcpu"`
	}
	if !valuesEqual(size{VCPU: 4}, map[string]any{"vcpu": float64(4)}) {
		t.Error("a struct compares by its JSON meaning")
	}
	if valuesEqual(make(chan int), make(chan int)) {
		t.Error("two values JSON cannot represent must not compare equal")
	}
	if got := formatFieldValue(make(chan int)); !strings.HasPrefix(got, "0x") {
		t.Errorf("an unrepresentable value renders as itself, got %q", got)
	}
}

// TestApply_JSONOutputCarriesARefusalBeforeFailing drives the refusal through the real `apply`
// command and the fake control plane: the PATCH is refused, the run is fatal, and `--output json`
// still prints the result naming the refused component, so a pipeline can read what happened.
func TestApply_JSONOutputCarriesARefusalBeforeFailing(t *testing.T) {
	s := &projServer{
		envs: []map[string]any{
			{"id": "e1", "name": "production", "stage": "production", "placement_mode": "dedicated", "status": "ACTIVE", "is_default": true},
		},
		comps: []map[string]any{
			{"id": "c1", "kind": "databases", "name": "orders", "status": "ACTIVE", "config": map[string]any{"engine": "postgres", "engine_version": "15"}},
		},
		failOnPost: []string{"/components/databases/orders"},
	}
	h := applyEnv(t, s)
	path := applyWriteManifest(t, "project: web\ncloud:\n  region: eu-west-1\nenvironments:\n  - name: production\n    stage: production\n    components:\n      databases:\n        - name: orders\n          engine_version: \"16\"\n")
	read := projCaptureStdout(t)
	if !h.run("apply", "--file", path, "--yes", "--runner", "primary", "--no-wait", "--no-input", "--output", "json") {
		t.Error("a refused update must make apply exit non-zero")
	}
	out := read()
	var got ApplyResult
	// The result comes first, then the failure line: decode the first JSON value only.
	if err := json.NewDecoder(strings.NewReader(out)).Decode(&got); err != nil {
		t.Fatalf("the partial result is not JSON: %v\n%s", err, out)
	}
	if len(got.Errors) != 1 || got.Errors[0].Component != "databases/orders" || got.Errors[0].Environment != "production" {
		t.Errorf("errors = %+v, want the refused databases/orders in production", got.Errors)
	}
	if len(got.Jobs) != 0 {
		t.Errorf("the environment with a refused change was deployed: %+v", got.Jobs)
	}
	var methods []string
	for _, p := range s.posts {
		methods = append(methods, p.Method+" "+p.Path)
	}
	if strings.Join(methods, " ") != "PATCH /api/cli/projects/p1/components/databases/orders" {
		t.Errorf("requests = %v, want one PATCH of orders", methods)
	}
}
