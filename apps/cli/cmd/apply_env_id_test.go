// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"reflect"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

// #5583: plan and apply address every environment by its ID. The server resolves `?env=` as id, name
// OR stage, so a NAME can resolve to another environment — and plan then diffs, and apply writes,
// the wrong one.

// stageNamedServer is the project #5583 describes: the DEFAULT environment `main` sits at stage
// `staging`, and a second environment is literally NAMED `staging`. The fake resolves a name the way
// the server did before #5583 (name OR stage, default first), so a request for "staging" by name
// lands on `main`. Each environment holds a different cluster size and different add-ons, so a read
// of the wrong one shows up in the diff.
func stageNamedServer() *addonFake {
	return &addonFake{
		diffFake: diffFake{
			byNameOrStage: true,
			envs: []api.Environment{
				{ID: "e-main", Name: "main", Stage: "staging", PlacementMode: "dedicated", IsDefault: true},
				{ID: "e-stg", Name: "staging", Stage: "development", PlacementMode: "namespace"},
			},
			comps: map[string][]api.Component{
				"main":    {{ID: "c-main", Kind: "cluster", Name: "cluster", Config: map[string]any{"node_max_size": float64(9)}}},
				"staging": {{ID: "c-stg", Kind: "cluster", Name: "cluster", Config: map[string]any{"node_max_size": float64(2)}}},
			},
		},
		catalog: addonCatalog(),
		addons: map[string][]api.Addon{
			"main": {{AddonID: "loki", Enabled: true, Mode: "managed", Version: sptr("6.0.0")}},
			"staging": {{AddonID: "cert-manager", Enabled: true, Mode: "managed", Version: sptr("1.14.4"),
				Settings: map[string]any{"installCRDs": true}}},
		},
	}
}

// stageNamedManifest declares only the environment named `staging`: its cluster grows from 2 to 4,
// and cert-manager is what it already runs.
const stageNamedManifest = `project: web
cloud:
  region: eu-west-1
environments:
  - name: staging
    stage: development
    placement: namespace
    components:
      cluster:
        node_max_size: 4
    addons:
      - id: cert-manager
`

func TestPlanAndApply_AStageNamedEnvironmentReadsAndWritesItself(t *testing.T) {
	f := stageNamedServer()
	plan, err := computePlan(f, diffManifest(t, stageNamedManifest), addonCatalog())
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Environments) != 1 {
		t.Fatalf("environments = %+v", plan.Environments)
	}
	env := plan.Environments[0]
	if env.ID != "e-stg" {
		t.Errorf("planned environment id = %q, want e-stg", env.ID)
	}

	// The diff is against `staging`'s own cluster (2), not the default's (9).
	wantChanges := []FieldChange{{Field: "node_max_size", From: float64(2), To: 4}}
	if len(env.Components) != 1 || env.Components[0].Action != ActionUpdate ||
		!reflect.DeepEqual(env.Components[0].Changes, wantChanges) {
		t.Errorf("staging's cluster = %+v, want update %+v", env.Components, wantChanges)
	}
	// cert-manager is staging's and matches; loki is main's and must not appear as unmanaged here.
	if len(env.Addons) != 1 || env.Addons[0].Action != ActionUnchanged {
		t.Errorf("staging's add-ons = %+v, want cert-manager unchanged", env.Addons)
	}
	if len(env.UnmanagedAddons) != 0 {
		t.Errorf("unmanaged add-ons = %v — those are the default environment's", env.UnmanagedAddons)
	}

	if _, err := executeApply(f, &bytes.Buffer{}, ui.FormatTable, plan, "", false); err != nil {
		t.Fatal(err)
	}
	// The write lands on `staging` — addressed by its id — and the default is never touched.
	wantCalls := []diffCall{{"upsert", "cluster", "", "staging", map[string]any{"node_max_size": 4}}}
	if !reflect.DeepEqual(f.calls, wantCalls) {
		t.Errorf("calls = %+v, want %+v", f.calls, wantCalls)
	}
	if !reflect.DeepEqual(f.jobs, []string{"e-stg"}) {
		t.Errorf("deployed %v, want [e-stg]", f.jobs)
	}
}

// An add-on the plan creates in that environment is enabled THERE, not in the default.
func TestApply_AStageNamedEnvironmentsAddonIsEnabledInItself(t *testing.T) {
	f := stageNamedServer()
	body := strings.Replace(stageNamedManifest, "      - id: cert-manager\n", "      - id: cert-manager\n      - id: loki\n", 1)
	plan, err := computePlan(f, diffManifest(t, body), addonCatalog())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := executeApply(f, &bytes.Buffer{}, ui.FormatTable, plan, "", false); err != nil {
		t.Fatal(err)
	}
	if len(f.enabled) != 1 || f.enabled[0].AddonID != "loki" || f.enabled[0].Env != "staging" {
		t.Errorf("EnableAddon calls = %+v, want loki in staging", f.enabled)
	}
}

// noIDFake is diffFake whose AddEnvironment answers without an id and whose list never shows the
// new environment: there is then nothing to address it by.
type noIDFake struct{ *diffFake }

// AddEnvironment accepts the environment and returns it without an id.
func (f noIDFake) AddEnvironment(p api.AddEnvironmentParams) (*api.Environment, error) {
	return &api.Environment{Name: p.Name, Stage: p.Stage}, nil
}

// An environment with no id is refused before anything is written into it: falling back to its
// name is exactly the ambiguity #5583 removed.
func TestExecuteApply_AnEnvironmentWithNoIdIsRefusedBeforeAnyWrite(t *testing.T) {
	inner := &diffFake{envs: []api.Environment{{ID: "e1", Name: "prod", Stage: "production", PlacementMode: "dedicated"}}}
	f := noIDFake{inner}
	m := diffManifest(t, "project: web\ncloud:\n  region: eu-west-1\nenvironments:\n  - name: prod\n    stage: production\n  - name: dev\n    stage: development\n    placement: namespace\n    components:\n      databases:\n        - name: orders\n          engine: postgres\n")
	plan, err := computePlan(f, m, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = executeApply(f, &bytes.Buffer{}, ui.FormatTable, plan, "", false)
	if err == nil || !strings.Contains(err.Error(), "environment dev was declared but the server does not list it") {
		t.Errorf("err = %v, want dev refused for having no id", err)
	}
	if len(inner.calls) != 0 || len(inner.jobs) != 0 {
		t.Errorf("wrote %+v and deployed %v into an environment with no id", inner.calls, inner.jobs)
	}
}
