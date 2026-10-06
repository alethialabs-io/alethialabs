// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/manifest"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

// Add-ons in plan and apply (#5528), driven at the applyClient seam.

// addonFake is diffFake plus the add-on routes: the add-ons each environment holds, the catalog,
// and every EnableAddon request it was sent.
type addonFake struct {
	diffFake
	addons      map[string][]api.Addon // by environment name
	catalog     *api.AddonCatalogDocument
	enabled     []api.EnableAddonParams
	refuseAddon map[string]error // by add-on id
	addonReads  int
}

func (f *addonFake) GetAddonCatalog() (*api.AddonCatalogDocument, error) { return f.catalog, nil }
func (f *addonFake) GetProjectAddons(_, env string) (*api.ProjectAddons, error) {
	f.addonReads++
	return &api.ProjectAddons{Environment: env, Addons: f.addons[env]}, nil
}
func (f *addonFake) EnableAddon(p api.EnableAddonParams) error {
	f.enabled = append(f.enabled, p)
	return f.refuseAddon[p.AddonID]
}

// addonCatalog is the catalog fixture, with the server's real chart-version rule.
func addonCatalog() *api.AddonCatalogDocument {
	return &api.AddonCatalogDocument{
		Addons: []api.AddonCatalogEntry{
			{ID: "cert-manager", Version: "1.14.4", Defaults: map[string]any{"installCRDs": true}},
			{ID: "external-dns", Version: "1.14.5", SecretKeys: []string{"apiToken"},
				Defaults: map[string]any{"policy": "upsert-only", "txtOwnerId": "alethia"}},
			{ID: "kube-prometheus-stack", Version: "58.2.1", SecretKeys: []string{"grafanaAdminPassword"},
				Defaults: map[string]any{"retention": "10d"}},
			{ID: "loki", Version: "6.0.0"},
		},
		ChartVersion: api.ChartVersionRule{
			Pattern:   `^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$`,
			MaxLength: 64,
			Refusal:   "A chart version must be one exact version, such as 58.2.1.",
		},
	}
}

func sptr(s string) *string { return &s }

// addonManifest is two environments: prod exists on the server, staging is new.
const addonManifest = `project: web
cloud:
  region: eu-west-1
environments:
  - name: prod
    stage: production
    addons:
      - id: cert-manager
      - id: external-dns
        version: 1.15.0
        settings:
          provider: cloudflare
          policy: sync
          txtOwnerId: null
      - id: kube-prometheus-stack
        values_file: kps.yaml
  - name: staging
    stage: staging
    placement: namespace
    addons:
      - id: external-dns
        version: 1.15.0
        mode: gitops
        settings:
          provider: cloudflare
        values:
          replicaCount: 2
`

// addonServer is prod as the server holds it: cert-manager matches, external-dns is unpinned with
// a stale policy and a txtOwnerId the file resets, kube-prometheus-stack carries an older override,
// and loki is enabled but not in the file.
func addonServer() *addonFake {
	return &addonFake{
		diffFake: diffFake{envs: []api.Environment{{ID: "e1", Name: "prod", Stage: "production", PlacementMode: "dedicated"}}},
		catalog:  addonCatalog(),
		addons: map[string][]api.Addon{"prod": {
			{AddonID: "cert-manager", Enabled: true, Mode: "managed", Version: sptr("1.14.4"), Settings: map[string]any{"installCRDs": true}},
			{AddonID: "external-dns", Enabled: true, Mode: "managed", Version: sptr("1.14.5"), SecretKeys: []string{"apiToken"},
				Settings: map[string]any{"provider": "cloudflare", "policy": "upsert-only", "txtOwnerId": "team-a"}},
			{AddonID: "kube-prometheus-stack", Enabled: true, Mode: "managed", Version: sptr("58.2.1"), SecretKeys: []string{"grafanaAdminPassword"},
				Settings: map[string]any{"retention": "10d"}, ValuesYAML: sptr("grafana:\n  replicas: 1\n")},
			{AddonID: "loki", Enabled: true, Mode: "managed", Version: sptr("6.0.0")},
		}},
	}
}

// planAddonManifest parses, loads the values file next to the manifest, validates against the
// catalog and computes the plan — planFromFile's steps, against the fake.
func planAddonManifest(t *testing.T, f *addonFake, body string, files map[string]string) *ApplyPlan {
	t.Helper()
	dir := t.TempDir()
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	path := filepath.Join(dir, manifest.FileName)
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	plan, err := planFromFile(f, path)
	if err != nil {
		t.Fatal(err)
	}
	return plan
}

func addonByID(t *testing.T, e EnvPlan, id string) AddonPlan {
	t.Helper()
	for _, a := range e.Addons {
		if a.ID == id {
			return a
		}
	}
	t.Fatalf("%s: no plan for add-on %s in %+v", e.Name, id, e.Addons)
	return AddonPlan{}
}

func TestComputePlan_Addons(t *testing.T) {
	f := addonServer()
	plan := planAddonManifest(t, f, addonManifest, map[string]string{"kps.yaml": "grafana:\n  replicas: 2\n"})
	prod, staging := plan.Environments[0], plan.Environments[1]

	if a := addonByID(t, prod, "cert-manager"); a.Action != ActionUnchanged || len(a.Changes) != 0 {
		t.Errorf("cert-manager matches the server: %+v", a)
	}
	ed := addonByID(t, prod, "external-dns")
	wantED := []FieldChange{
		{Field: "settings", Key: "policy", From: "upsert-only", To: "sync"},
		{Field: "settings", Key: "txtOwnerId", From: "team-a", To: nil},
		{Field: "version", From: addonDefaultLabel, To: "1.15.0"},
	}
	if ed.Action != ActionUpdate || !reflect.DeepEqual(ed.Changes, wantED) {
		t.Errorf("external-dns = %s %#v, want update %#v", ed.Action, ed.Changes, wantED)
	}
	kps := addonByID(t, prod, "kube-prometheus-stack")
	if kps.Action != ActionUpdate || len(kps.Changes) != 1 || kps.Changes[0].Field != "values" {
		t.Fatalf("kube-prometheus-stack = %s %#v, want one values change", kps.Action, kps.Changes)
	}
	if ch := kps.Changes[0]; ch.From != nil || ch.To != "changed (2 lines)" {
		t.Errorf("values change = %#v → %#v, want nil → \"changed (2 lines)\"", ch.From, ch.To)
	}
	if !reflect.DeepEqual(prod.UnmanagedAddons, []string{"loki"}) {
		t.Errorf("loki is on the server and not in the file — unmanaged, got %v", prod.UnmanagedAddons)
	}
	if a := addonByID(t, staging, "external-dns"); a.Action != ActionCreate {
		t.Errorf("staging is a new environment, so its add-on is created: %+v", a)
	}
	if f.addonReads != 1 {
		t.Errorf("add-ons read %d times, want once (prod exists; staging does not)", f.addonReads)
	}
}

func TestComputePlan_AddonVersionKeepAndClear(t *testing.T) {
	pinned := api.Addon{AddonID: "loki", Enabled: true, Mode: "managed", Version: sptr("6.0.0"), VersionPinned: true}
	unpinned := api.Addon{AddonID: "loki", Enabled: true, Mode: "managed", Version: sptr("6.0.0")}
	for name, tc := range map[string]struct {
		line string
		row  api.Addon
		want []FieldChange
	}{
		"omitted keeps a pin":               {"", pinned, nil},
		"the same pin is unchanged":         {"        version: 6.0.0\n", pinned, nil},
		"a new pin":                         {"        version: 6.1.0\n", pinned, []FieldChange{{Field: "version", From: "6.0.0", To: "6.1.0"}}},
		"pinning the default is a change":   {"        version: 6.0.0\n", unpinned, []FieldChange{{Field: "version", From: addonDefaultLabel, To: "6.0.0"}}},
		`"" clears a pin`:                   {"        version: \"\"\n", pinned, []FieldChange{{Field: "version", From: "6.0.0", To: addonDefaultLabel}}},
		"null clears a pin":                 {"        version: null\n", pinned, []FieldChange{{Field: "version", From: "6.0.0", To: addonDefaultLabel}}},
		"clearing an absent pin is nothing": {"        version: \"\"\n", unpinned, nil},
	} {
		t.Run(name, func(t *testing.T) {
			f := addonServer()
			f.addons = map[string][]api.Addon{"prod": {tc.row}}
			plan := planAddonManifest(t, f, "project: web\ncloud:\n  region: eu-west-1\nenvironments:\n  - name: prod\n    stage: production\n    addons:\n      - id: loki\n"+tc.line, nil)
			got := plan.Environments[0].Addons[0]
			if !reflect.DeepEqual(got.Changes, tc.want) {
				t.Errorf("changes = %#v, want %#v", got.Changes, tc.want)
			}
		})
	}
}

func TestComputePlan_ASettingResetSettlesOnTheCatalogDefault(t *testing.T) {
	f := addonServer()
	// After the reset apply, the server stores the default — and the plan must then be quiet.
	f.addons = map[string][]api.Addon{"prod": {{AddonID: "external-dns", Enabled: true, Mode: "managed", Version: sptr("1.14.5"),
		Settings: map[string]any{"provider": "cloudflare", "txtOwnerId": "alethia"}}}}
	plan := planAddonManifest(t, f, "project: web\ncloud:\n  region: eu-west-1\nenvironments:\n  - name: prod\n    stage: production\n    addons:\n      - id: external-dns\n        settings:\n          txtOwnerId: null\n", nil)
	if a := plan.Environments[0].Addons[0]; a.Action != ActionUnchanged {
		t.Errorf("a reset that already holds the default is unchanged, got %s %v", a.Action, a.Changes)
	}
}

func TestComputePlan_AddonOverrideClearAndKeep(t *testing.T) {
	row := api.Addon{AddonID: "loki", Enabled: true, Mode: "managed", Version: sptr("6.0.0"), ValuesYAML: sptr("a: 1\n")}
	for name, tc := range map[string]struct {
		lines  string
		change bool
	}{
		"no values key keeps the override":     {"", false},
		"the same mapping inline is unchanged": {"        values:\n          a: 1\n", false},
		"values_file \"\" removes it":          {"        values_file: \"\"\n", true},
		"values: null removes it":              {"        values: null\n", true},
		"a different mapping replaces it":      {"        values:\n          a: 2\n", true},
	} {
		t.Run(name, func(t *testing.T) {
			f := addonServer()
			f.addons = map[string][]api.Addon{"prod": {row}}
			plan := planAddonManifest(t, f, "project: web\ncloud:\n  region: eu-west-1\nenvironments:\n  - name: prod\n    stage: production\n    addons:\n      - id: loki\n"+tc.lines, nil)
			if got := plan.Environments[0].Addons[0].Action == ActionUpdate; got != tc.change {
				t.Errorf("update = %v, want %v (%+v)", got, tc.change, plan.Environments[0].Addons[0])
			}
		})
	}
}

func TestPlanFromFile_RefusesASecretSettingAndAnUnknownAddon(t *testing.T) {
	for name, tc := range map[string]struct{ lines, want string }{
		"secret":  {"      - id: external-dns\n        settings:\n          apiToken: s3cr3t-value\n", "apiToken is a secret setting"},
		"unknown": {"      - id: not-an-addon\n", `"not-an-addon" is not a catalog add-on`},
		"range":   {"      - id: loki\n        version: ~6.0\n", `version "~6.0"`},
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, manifest.FileName)
			body := "project: web\ncloud:\n  region: eu-west-1\nenvironments:\n  - name: prod\n    stage: production\n    addons:\n" + tc.lines
			if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
				t.Fatal(err)
			}
			_, err := planFromFile(addonServer(), path)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("planFromFile = %v, want %q", err, tc.want)
			}
			if strings.Contains(err.Error(), "s3cr3t-value") {
				t.Errorf("the refusal printed the secret's value: %v", err)
			}
		})
	}
}

func TestComputePlan_ARowsSecretKeysRefuseEvenWithoutACatalog(t *testing.T) {
	f := addonServer()
	m := diffManifest(t, "project: web\ncloud:\n  region: eu-west-1\nenvironments:\n  - name: prod\n    stage: production\n    addons:\n      - id: external-dns\n        settings:\n          apiToken: s3cr3t-value\n")
	plan, err := computePlan(f, m, nil)
	if err != nil {
		t.Fatal(err)
	}
	refusal := plan.refusal()
	if refusal == nil || !strings.Contains(refusal.Error(), "apiToken is a secret setting") || strings.Contains(refusal.Error(), "s3cr3t-value") {
		t.Fatalf("refusal = %v, want the secret refused by name and never printed", refusal)
	}
	var out bytes.Buffer
	renderPlan(&out, plan)
	if strings.Contains(out.String(), "s3cr3t-value") {
		t.Errorf("the plan printed a secret value:\n%s", out.String())
	}
}

func TestRenderAddonChange_RedactsASecretSetting(t *testing.T) {
	ch := FieldChange{Field: "settings", Key: "apiToken", From: "old-secret", To: "new-secret"}
	for _, v := range []any{ch.From, ch.To} {
		if got := addonFieldValue(ch, v, []string{"apiToken"}); got != addonSecretLabel {
			t.Errorf("a secret setting rendered as %q", got)
		}
	}
	if got := addonFieldValue(FieldChange{Field: "settings", Key: "policy"}, nil, nil); got != "(default)" {
		t.Errorf("a reset renders as %q, want (default)", got)
	}
}

func TestRenderPlan_ShowsAddonsPerEnvironment(t *testing.T) {
	plan := planAddonManifest(t, addonServer(), addonManifest, map[string]string{"kps.yaml": "grafana:\n  replicas: 2\n"})
	var out bytes.Buffer
	renderPlan(&out, plan)
	text := out.String()
	for _, want := range []string{
		"add-ons  = cert-manager  ~ external-dns  ~ kube-prometheus-stack",
		"~ external-dns  version: (catalog default) → 1.15.0",
		"~ external-dns  settings.policy: upsert-only → sync",
		"~ external-dns  settings.txtOwnerId: team-a → (default)",
		"~ kube-prometheus-stack  values: changed (2 lines)\n",
		"add-on loki is enabled on the server and not in the file — left alone (unmanaged)",
		"add-ons  + external-dns",
		"1 add-on to enable · 2 to change",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("plan output is missing %q:\n%s", want, text)
		}
	}
}

func TestExecuteApply_EnablesCreatesAndUpdatesOnly(t *testing.T) {
	f := addonServer()
	f.envs = append(f.envs, api.Environment{ID: "e2", Name: "staging", Stage: "staging", PlacementMode: "namespace"})
	f.addons["staging"] = nil
	plan := planAddonManifest(t, f, addonManifest, map[string]string{"kps.yaml": "grafana:\n  replicas: 2\n"})
	if _, err := executeApply(f, &bytes.Buffer{}, ui.FormatTable, plan, "", false); err != nil {
		t.Fatal(err)
	}
	stagingValues := "replicaCount: 2\n"
	want := []api.EnableAddonParams{
		// external-dns: ONLY what changed — the pin and the two settings; mode and override untouched.
		{Project: "p1", Env: "prod", AddonID: "external-dns", Version: sptr("1.15.0"),
			Values: map[string]any{"policy": "sync", "txtOwnerId": nil}},
		// kube-prometheus-stack: the values file's own text, nothing else.
		{Project: "p1", Env: "prod", AddonID: "kube-prometheus-stack", ValuesYAML: sptr("grafana:\n  replicas: 2\n")},
		// staging's first install: everything the file declares.
		{Project: "p1", Env: "staging", AddonID: "external-dns", Mode: "gitops", Version: sptr("1.15.0"),
			Values: map[string]any{"provider": "cloudflare"}, ValuesYAML: &stagingValues},
	}
	if !reflect.DeepEqual(f.enabled, want) {
		t.Errorf("EnableAddon calls:\n got %#v\nwant %#v", f.enabled, want)
	}
	for _, p := range f.enabled {
		if p.AddonID == "cert-manager" || p.AddonID == "loki" {
			t.Errorf("apply touched %s, which is unchanged or unmanaged", p.AddonID)
		}
	}
	if len(f.jobs) != 2 {
		t.Errorf("deploys queued for %v, want both environments", f.jobs)
	}
}

func TestExecuteApply_ARefusedAddonHoldsBackOnlyItsEnvironment(t *testing.T) {
	f := addonServer()
	f.envs = append(f.envs, api.Environment{ID: "e2", Name: "staging", Stage: "staging", PlacementMode: "namespace"})
	f.addons["staging"] = nil
	f.refuseAddon = map[string]error{"kube-prometheus-stack": errors.New("Advanced values must be valid YAML describing a mapping")}
	plan := planAddonManifest(t, f, addonManifest, map[string]string{"kps.yaml": "grafana:\n  replicas: 2\n"})
	var out bytes.Buffer
	result, err := executeApply(f, &out, ui.FormatTable, plan, "", false)
	if err == nil || !strings.Contains(err.Error(), "prod addon/kube-prometheus-stack") {
		t.Fatalf("err = %v, want the refused add-on named", err)
	}
	if !reflect.DeepEqual(f.jobs, []string{"e2"}) {
		t.Errorf("deploys = %v, want staging only (prod's add-on was refused)", f.jobs)
	}
	if len(result.Errors) != 1 {
		t.Errorf("errors = %+v", result.Errors)
	}
	// The held-back line names what was refused: an add-on, not a component.
	if text := out.String(); !strings.Contains(text, "prod not deployed: an add-on change was refused") ||
		strings.Contains(text, "component update was refused") {
		t.Errorf("the not-deployed line misnames the refusal:\n%s", text)
	}
}

func TestRefusedKinds_Sentence(t *testing.T) {
	for _, tc := range []struct {
		r    refusedKinds
		want string
	}{
		{refusedKinds{component: true}, "a component update was refused"},
		{refusedKinds{addon: true}, "an add-on change was refused"},
		{refusedKinds{component: true, addon: true}, "a component update and an add-on change were refused"},
	} {
		if got := tc.r.sentence(); got != tc.want {
			t.Errorf("%+v = %q, want %q", tc.r, got, tc.want)
		}
	}
}

func TestPlanFromFile_WithoutAddonsReadsNoAddonRoutes(t *testing.T) {
	// diffFake has no add-on methods: any call to one panics through the nil embedded interface.
	f := diffTwoEnvFake()
	dir := t.TempDir()
	path := filepath.Join(dir, manifest.FileName)
	body := "project: web\ncloud:\n  region: eu-west-1\nenvironments:\n  - name: prod\n    stage: production\n"
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	plan, err := planFromFile(f, path)
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	renderPlan(&out, plan)
	if strings.Contains(out.String(), "add-on") {
		t.Errorf("a file without add-ons printed add-on lines:\n%s", out.String())
	}
}
