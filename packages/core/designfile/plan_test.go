// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package designfile

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// fakeOrg is an organization as a plan reads it. It has no write methods at all, so a plan that
// tried to write would not compile against it.
type fakeOrg struct {
	account    api.CloudIdentity
	accountErr error
	projects   []types.ConfigurationSummary
	envs       []api.Environment
	components map[string][]api.Component
	addons     map[string][]api.Addon
	fail       map[string]error
	calls      []string
}

// ResolveCloudAccount returns the one account the fake holds.
func (f *fakeOrg) ResolveCloudAccount(ref string) (api.CloudIdentity, error) {
	f.calls = append(f.calls, "account:"+ref)
	return f.account, f.accountErr
}

// GetConfigurations lists the fake's projects.
func (f *fakeOrg) GetConfigurations() ([]types.ConfigurationSummary, error) {
	f.calls = append(f.calls, "projects")
	return f.projects, f.fail["projects"]
}

// ListEnvironments lists the fake's environments.
func (f *fakeOrg) ListEnvironments(project string) ([]api.Environment, error) {
	f.calls = append(f.calls, "envs:"+project)
	return f.envs, f.fail["envs"]
}

// ListComponents lists one environment's components, addressed by environment id.
func (f *fakeOrg) ListComponents(project, kind, env string) ([]api.Component, error) {
	f.calls = append(f.calls, "components:"+env)
	return f.components[env], f.fail["components"]
}

// GetProjectAddons lists one environment's add-ons, addressed by environment id.
func (f *fakeOrg) GetProjectAddons(project, env string) (*api.ProjectAddons, error) {
	f.calls = append(f.calls, "addons:"+env)
	if err := f.fail["addons"]; err != nil {
		return nil, err
	}
	return &api.ProjectAddons{Addons: f.addons[env]}, nil
}

// strptr is a pointer to s.
func strptr(s string) *string { return &s }

const planned = `project: Boutique
cloud:
  account: prod-account
  region: nbg1
environments:
  - name: prod
    stage: production
    components:
      cluster:
        node_min_size: 2
        node_max_size: 3
      databases:
        - name: orders
          engine: postgres
        - name: audit
          engine: postgres
    addons:
      - id: loki
      - id: external-dns
        version: 1.15.0
        settings:
          provider: cloudflare
  - name: dev-1
    stage: development
`

// existingOrg is an organization that already holds the project, with one environment and one
// component the file does not mention.
func existingOrg() *fakeOrg {
	return &fakeOrg{
		account:  api.CloudIdentity{ID: "id-1", Provider: "hetzner", Label: "prod-account"},
		projects: []types.ConfigurationSummary{{ID: "p1", ProjectName: "boutique"}, {ID: "p2", ProjectName: "other"}},
		envs: []api.Environment{
			{ID: "e-prod", Name: "prod", Stage: "production", PlacementMode: "dedicated", Lifecycle: "persistent"},
			{ID: "e-old", Name: "old-preview", Stage: "development", PlacementMode: "namespace"},
		},
		components: map[string][]api.Component{"e-prod": {
			{Kind: "cluster", Config: map[string]any{"node_min_size": float64(2), "node_max_size": float64(5), "version": "1.31"}, UpdatedAt: strptr("rev-1")},
			{Kind: "databases", Name: "orders", Config: map[string]any{"engine": "postgres"}, CloudIdentityID: strptr("id-9")},
			{Kind: "databases", Name: "not-in-the-file", Config: map[string]any{"engine": "mysql"}},
		}},
		addons: map[string][]api.Addon{"e-prod": {
			{AddonID: "external-dns", Enabled: true, Mode: "managed", Version: strptr("1.14.5"), VersionPinned: true, Settings: map[string]any{"provider": "cloudflare"}},
			{AddonID: "kube-prometheus-stack", Enabled: true},
		}},
	}
}

func TestComputePlan_ANewProjectCreatesEverything(t *testing.T) {
	org := &fakeOrg{account: api.CloudIdentity{ID: "id-1", Provider: "hetzner"}}
	p, err := ComputePlan(org, mustParse(t, planned), nil)
	if err != nil {
		t.Fatalf("ComputePlan: %v", err)
	}
	if p.ProjectID != "" || p.IdentityID != "id-1" || p.Provider != "hetzner" || !p.HasChanges() {
		t.Fatalf("plan header: %+v", p)
	}
	envs, comps, updates := p.Counts()
	enable, change := p.AddonCounts()
	if envs != 2 || comps != 3 || updates != 0 || enable != 2 || change != 0 {
		t.Fatalf("counts: %d envs, %d components, %d updates, %d add-ons, %d changed", envs, comps, updates, enable, change)
	}
	// Nothing exists, so nothing below the project list is read.
	if want := []string{"account:prod-account", "projects"}; !reflect.DeepEqual(org.calls, want) {
		t.Fatalf("reads = %q, want %q", org.calls, want)
	}
	if req := p.Environments[0].Addons[1].Request; req.AddonID != "external-dns" || req.Env != "prod" || req.Version == nil || *req.Version != "1.15.0" {
		t.Fatalf("the create request does not carry what the file declares: %+v", req)
	}
}

func TestComputePlan_AgainstAnExistingProject(t *testing.T) {
	org := existingOrg()
	catalog := &api.AddonCatalogDocument{Addons: []api.AddonCatalogEntry{{ID: "external-dns", SecretKeys: []string{"apiToken"}}, {ID: "loki"}}}
	p, err := ComputePlan(org, mustParse(t, planned), catalog)
	if err != nil {
		t.Fatalf("ComputePlan: %v", err)
	}
	if p.ProjectID != "p1" {
		t.Fatalf("the project was not found case-insensitively: %q", p.ProjectID)
	}
	prod, dev := p.Environments[0], p.Environments[1]
	if prod.Action != ActionUnchanged || prod.ID != "e-prod" || dev.Action != ActionCreate || dev.ID != "" {
		t.Fatalf("environment actions: %+v / %+v", prod, dev)
	}
	got := map[string]ComponentPlan{}
	for _, c := range prod.Components {
		got[componentRefText(c.Kind, c.Name)] = c
	}
	cluster := got["cluster"]
	wantChange := []FieldChange{{Field: "node_max_size", From: float64(5), To: 3}}
	if cluster.Action != ActionUpdate || !reflect.DeepEqual(cluster.Changes, wantChange) || cluster.Revision != "rev-1" {
		t.Fatalf("cluster = %+v", cluster)
	}
	// `version` is on the server and not in the file: read, kept, and no change.
	if cluster.Read["version"] != "1.31" {
		t.Fatalf("the plan did not keep what it read: %v", cluster.Read)
	}
	if got["databases/orders"].Action != ActionUnchanged || got["databases/orders"].Read["cloud_identity_id"] != "id-9" {
		t.Fatalf("databases/orders = %+v", got["databases/orders"])
	}
	if got["databases/audit"].Action != ActionCreate {
		t.Fatalf("databases/audit = %+v", got["databases/audit"])
	}
	loki, dns := prod.Addons[0], prod.Addons[1]
	wantDNS := []FieldChange{{Field: "version", From: "1.14.5", To: "1.15.0"}}
	if loki.Action != ActionCreate || dns.Action != ActionUpdate || !reflect.DeepEqual(dns.Changes, wantDNS) {
		t.Fatalf("add-ons: %+v / %+v", loki, dns)
	}
	if dns.Request.Version == nil || *dns.Request.Version != "1.15.0" || dns.Request.Values != nil || dns.Request.Mode != "" {
		t.Fatalf("an update must send only what changed: %+v", dns.Request)
	}
	if !reflect.DeepEqual(p.AddonSecretKeys("external-dns"), []string{"apiToken"}) || p.AddonSecretKeys("nope") != nil {
		t.Fatalf("secret keys: %v", p.AddonSecretKeys("external-dns"))
	}
	envs, comps, updates := p.Counts()
	enable, change := p.AddonCounts()
	if envs != 1 || comps != 1 || updates != 1 || enable != 1 || change != 1 {
		t.Fatalf("counts: %d %d %d %d %d", envs, comps, updates, enable, change)
	}
	// Every per-environment read addresses the environment by id.
	want := []string{"account:prod-account", "projects", "envs:p1", "components:e-prod", "addons:e-prod"}
	if !reflect.DeepEqual(org.calls, want) {
		t.Fatalf("reads = %q, want %q", org.calls, want)
	}
	// The serialized plan carries none of the working fields.
	raw, err := json.Marshal(p)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	for _, leaked := range []string{"Catalog", "Read", "Request", "SecretKeys", "apiToken", "1.31"} {
		if strings.Contains(string(raw), leaked) {
			t.Fatalf("the serialized plan carries %q:\n%s", leaked, raw)
		}
	}
}

func TestComputePlan_WhatTheFileDoesNotMentionIsListedAndLeftAlone(t *testing.T) {
	// The rule for the whole file: omission never removes. An environment, a component and an
	// add-on are each on the server and absent from the file, and the plan must carry no action
	// against any of them — only the two lists that say they were seen and left as they are.
	p, err := ComputePlan(existingOrg(), mustParse(t, planned), nil)
	if err != nil {
		t.Fatalf("ComputePlan: %v", err)
	}
	if !reflect.DeepEqual(p.Unmanaged, []string{"old-preview"}) {
		t.Fatalf("Unmanaged = %q", p.Unmanaged)
	}
	if !reflect.DeepEqual(p.Environments[0].UnmanagedAddons, []string{"kube-prometheus-stack"}) {
		t.Fatalf("UnmanagedAddons = %q", p.Environments[0].UnmanagedAddons)
	}
	raw, _ := json.Marshal(p)
	for _, word := range []string{"not-in-the-file", `"remove"`, `"omitted"`, "delete", "destroy", "disable"} {
		if strings.Contains(string(raw), word) {
			t.Fatalf("the plan mentions %q, so something the file left out was given an action:\n%s", word, raw)
		}
	}
	for _, e := range p.Environments {
		if e.Name == "old-preview" {
			t.Fatal("an environment the file does not mention was planned")
		}
		for _, c := range e.Components {
			if c.Action != ActionCreate && c.Action != ActionUpdate && c.Action != ActionUnchanged {
				t.Fatalf("component action %q", c.Action)
			}
		}
		for _, a := range e.Addons {
			if a.Action != ActionCreate && a.Action != ActionUpdate && a.Action != ActionUnchanged {
				t.Fatalf("add-on action %q", a.Action)
			}
		}
	}

	// A file that declares nothing for an environment reads nothing about it, and still removes nothing.
	bare := mustParse(t, "project: boutique\ncloud:\n  region: nbg1\nenvironments:\n  - name: prod\n    stage: production\n")
	org := existingOrg()
	p, err = ComputePlan(org, bare, nil)
	if err != nil {
		t.Fatalf("ComputePlan: %v", err)
	}
	if p.HasChanges() || len(p.Environments[0].Components) != 0 || len(p.Environments[0].Addons) != 0 {
		t.Fatalf("a file that declares nothing plans a change: %+v", p)
	}
	if want := []string{"projects", "envs:p1"}; !reflect.DeepEqual(org.calls, want) {
		t.Fatalf("reads = %q, want %q", org.calls, want)
	}
}

func TestComputePlan_ProblemsRefuse(t *testing.T) {
	org := existingOrg()
	org.envs[0].Stage, org.envs[0].PlacementMode, org.envs[0].Lifecycle = "staging", "namespace", "ephemeral"
	p, err := ComputePlan(org, mustParse(t, planned), nil)
	if err != nil {
		t.Fatalf("ComputePlan: %v", err)
	}
	problems := strings.Join(p.Environments[0].Problems, "\n")
	for _, want := range []string{
		"the file says stage production, the server has staging",
		"the file says placement dedicated, the server has namespace",
		"the file says lifecycle persistent, the server has ephemeral",
		"set it to `lifecycle: ephemeral`",
	} {
		if !strings.Contains(problems, want) {
			t.Fatalf("missing %q in:\n%s", want, problems)
		}
	}
	refusal := p.Refusal()
	if refusal == nil || !strings.HasPrefix(refusal.Error(), "alethia.yaml cannot be applied as written:\n  - prod: ") {
		t.Fatalf("Refusal = %v", refusal)
	}
	if clean, _ := ComputePlan(existingOrg(), mustParse(t, planned), nil); clean.Refusal() != nil {
		t.Fatalf("a plan with no problems was refused: %v", clean.Refusal())
	}
}

func TestLifecycleProblem(t *testing.T) {
	if lifecycleProblem("", "") != "" || lifecycleProblem("ephemeral", "") != "" {
		t.Error("a server that reports no lifecycle is not compared against")
	}
	if lifecycleProblem("", DefaultLifecycle) != "" || lifecycleProblem("ephemeral", "ephemeral") != "" {
		t.Error("an omitted lifecycle is the default, and equal ones agree")
	}
	if got := lifecycleProblem("ephemeral", DefaultLifecycle); !strings.Contains(got, "remove `lifecycle` or set it to `lifecycle: persistent`") {
		t.Errorf("the default's two spellings are not both named: %s", got)
	}
}

func TestComputePlan_ReadFailuresAreNamed(t *testing.T) {
	boom := errors.New("boom")
	for step, want := range map[string]string{
		"projects":   "list projects: boom",
		"envs":       "list environments of Boutique: boom",
		"components": "list components of Boutique/prod: boom",
		"addons":     "list add-ons of Boutique/prod: boom",
	} {
		org := existingOrg()
		org.fail = map[string]error{step: boom}
		if _, err := ComputePlan(org, mustParse(t, planned), nil); err == nil || err.Error() != want {
			t.Errorf("%s: err = %v, want %q", step, err, want)
		}
	}
	org := existingOrg()
	org.accountErr = boom
	if _, err := ComputePlan(org, mustParse(t, planned), nil); !errors.Is(err, boom) {
		t.Errorf("account: err = %v", err)
	}
	org = existingOrg()
	org.projects = append(org.projects, types.ConfigurationSummary{ID: "p3", ProjectName: "BOUTIQUE"})
	if _, err := ComputePlan(org, mustParse(t, planned), nil); err == nil || !strings.Contains(err.Error(), "matches 2 projects") {
		t.Errorf("two projects under one name: err = %v", err)
	}
}

func TestPlan_RestrictTo(t *testing.T) {
	p, err := ComputePlan(existingOrg(), mustParse(t, planned), nil)
	if err != nil {
		t.Fatalf("ComputePlan: %v", err)
	}
	if err := p.RestrictTo(nil); err != nil || !p.Environments[0].Deploy || !p.Environments[1].Deploy {
		t.Fatalf("no --env must deploy everything: %v", err)
	}
	if err := p.RestrictTo([]string{"Dev-1"}); err != nil || p.Environments[0].Deploy || !p.Environments[1].Deploy {
		t.Fatalf("--env dev-1: %v, %+v", err, p.Environments)
	}
	// Narrowing the deploy does not narrow what is created.
	if envs, _, _ := p.Counts(); envs != 1 {
		t.Fatalf("restricting the deploy changed what is created: %d", envs)
	}
	err = p.RestrictTo([]string{"prod", "nope"})
	if err == nil || err.Error() != "--env names nope, which the file does not declare (have: prod, dev-1)" {
		t.Fatalf("an undeclared --env: %v", err)
	}
}

func TestPlanAddons_KeepClearAndSecrets(t *testing.T) {
	catalog := &api.AddonCatalogDocument{Addons: []api.AddonCatalogEntry{
		{ID: "dns", Version: "1.0.0", SecretKeys: []string{"token"}, Defaults: map[string]any{"interval": "1m"}},
	}}
	stored := []api.Addon{{
		AddonID: "dns", Enabled: true, Mode: "managed", Version: strptr("1.0.0"),
		Settings: map[string]any{"interval": "5m", "zone": "a"}, ValuesYAML: strptr("replicas: 2\n"), SecretKeys: []string{"legacyKey"},
	}}
	plan := func(a Addon) AddonPlan {
		t.Helper()
		plans, _, problems := PlanAddons(Environment{Name: "prod", Addons: []Addon{a}}, stored, catalog)
		if len(problems) != 0 || len(plans) != 1 {
			t.Fatalf("plans %+v, problems %q", plans, problems)
		}
		return plans[0]
	}
	if got := plan(Addon{ID: "dns"}); got.Action != ActionUnchanged || got.Changes != nil {
		t.Fatalf("an entry that names nothing changes nothing: %+v", got)
	}
	empty := ""
	if got := plan(Addon{ID: "dns", Version: &empty}); got.Action != ActionUnchanged {
		t.Fatalf("clearing a pin that is not there is no change: %+v", got)
	}
	pin := "1.0.0"
	got := plan(Addon{ID: "dns", Version: &pin, Mode: "gitops", Settings: map[string]any{"interval": nil, "zone": "a", "extra": 1}, ValuesCleared: true})
	want := []FieldChange{
		{Field: "mode", From: "managed", To: "gitops"},
		{Field: "settings", Key: "extra", From: nil, To: 1},
		{Field: "settings", Key: "interval", From: "5m", To: nil},
		{Field: "values", To: OverrideRemoved},
		{Field: "version", From: AddonDefaultLabel, To: "1.0.0"},
	}
	if got.Action != ActionUpdate || !reflect.DeepEqual(got.Changes, want) {
		t.Fatalf("changes = %+v\nwant %+v", got.Changes, want)
	}
	if !reflect.DeepEqual(got.SecretKeys, []string{"token", "legacyKey"}) {
		t.Fatalf("secret keys from the catalog and the row: %v", got.SecretKeys)
	}
	if req := got.Request; req.Mode != "gitops" || req.ValuesYAML == nil || *req.ValuesYAML != "" ||
		!reflect.DeepEqual(req.Values, map[string]any{"extra": 1, "interval": nil}) {
		t.Fatalf("request = %+v", req)
	}
	// A reset to the default the server already holds settles.
	stored[0].Settings["interval"] = "1m"
	if got := plan(Addon{ID: "dns", Settings: map[string]any{"interval": nil}}); got.Action != ActionUnchanged {
		t.Fatalf("a reset that already holds is still a change: %+v", got)
	}
	// The override is compared by meaning and summarised without its content.
	same := plan(Addon{ID: "dns", Values: map[string]any{"replicas": 2}})
	other := plan(Addon{ID: "dns", ValuesFile: strptr("v.yaml"), ValuesFileContent: "replicas: 3\nsecret: hunter2\n"})
	if same.Action != ActionUnchanged || len(other.Changes) != 1 || other.Changes[0].To != "changed (2 lines)" || other.Changes[0].From != nil {
		t.Fatalf("override: %+v / %+v", same, other)
	}
	if one := plan(Addon{ID: "dns", Values: map[string]any{"a": 1}}); one.Changes[0].To != "changed (1 line)" {
		t.Fatalf("one line: %+v", one.Changes)
	}

	// A secret setting is refused by either list, and a broken values file by name only.
	for name, a := range map[string]Addon{
		"catalog secret": {ID: "dns", Settings: map[string]any{"token": "x"}},
		"row secret":     {ID: "dns", Settings: map[string]any{"legacyKey": "x"}},
		"not a mapping":  {ID: "dns", ValuesFile: strptr("v.yaml"), ValuesFileContent: "- a\n- b\n"},
		"not yaml":       {ID: "dns", ValuesFile: strptr("v.yaml"), ValuesFileContent: "a: [\n"},
	} {
		plans, _, problems := PlanAddons(Environment{Name: "prod", Addons: []Addon{a}}, stored, catalog)
		if len(plans) != 0 || len(problems) != 1 || strings.Contains(problems[0], "hunter2") {
			t.Fatalf("%s: plans %+v, problems %q", name, plans, problems)
		}
	}
}

func TestOverrideHelpers(t *testing.T) {
	for in, wantNil := range map[string]bool{"": true, "  \n": true, "# only a comment\n": true, "a: 1\n": false} {
		m, err := ParseOverride(in)
		if err != nil || (m == nil) != wantNil {
			t.Errorf("ParseOverride(%q) = %v, %v", in, m, err)
		}
	}
	if _, err := ParseOverride("a:\n  b: !!binary x\n"); err == nil {
		t.Error("a mapping that does not decode was accepted")
	}
	empty, text := "", "a: 1\n"
	cases := map[string]struct {
		a    Addon
		want *string
	}{
		"nothing declared":    {Addon{}, nil},
		"values: null":        {Addon{ValuesCleared: true}, &empty},
		"an empty mapping":    {Addon{Values: map[string]any{}}, &empty},
		"an inline mapping":   {Addon{Values: map[string]any{"a": 1}}, &text},
		`values_file: ""`:     {Addon{ValuesFile: &empty}, &empty},
		"an empty file":       {Addon{ValuesFile: strptr("v.yaml"), ValuesFileContent: " \n"}, &empty},
		"a file with content": {Addon{ValuesFile: strptr("v.yaml"), ValuesFileContent: text}, &text},
	}
	for name, tc := range cases {
		got := OverrideText(tc.a)
		if (got == nil) != (tc.want == nil) || (got != nil && *got != *tc.want) {
			t.Errorf("%s: OverrideText = %v, want %v", name, got, tc.want)
		}
	}
	if derefString(nil) != "" {
		t.Error("derefString(nil) must be empty")
	}
}
