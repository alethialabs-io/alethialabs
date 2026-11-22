// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package designfile

import (
	"errors"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// The export, from this package's side: what a caller that is not the CLI gets from BuildExport.
// The allow-list's own cases — every shape of value it keeps out of the file — are exercised
// where the generated list of template knobs lives, in apps/cli/cmd/export_test.go.

// exportOrg is a fakeOrg that also answers the reads only the export makes.
type exportOrg struct {
	*fakeOrg
	settings   *api.ProjectSettings
	identities []api.CloudIdentity
	schema     *api.ComponentSchemaDocument
}

// GetProjectSettings returns the project's region, version and account.
func (o *exportOrg) GetProjectSettings(string) (*api.ProjectSettings, error) {
	return o.settings, o.fail["settings"]
}

// GetCloudIdentities lists the organization's cloud accounts.
func (o *exportOrg) GetCloudIdentities() ([]api.CloudIdentity, error) {
	return o.identities, o.fail["identities"]
}

// GetComponentSchema returns the published component registry.
func (o *exportOrg) GetComponentSchema() (*api.ComponentSchemaDocument, error) {
	return o.schema, o.fail["schema"]
}

// GetAddonCatalog returns an empty catalog: these environments run no add-on.
func (o *exportOrg) GetAddonCatalog() (*api.AddonCatalogDocument, error) {
	return &api.AddonCatalogDocument{}, o.fail["catalog"]
}

// GetProjectByoCharts reports no chart of the project's own.
func (o *exportOrg) GetProjectByoCharts(_, env string) (*api.ProjectByoCharts, error) {
	return &api.ProjectByoCharts{Environment: env}, nil
}

// GetProjectIacSource reports no infrastructure source of the project's own.
func (o *exportOrg) GetProjectIacSource(string, string) (*api.IacSource, error) { return nil, nil }

// exportFixture is a project with two environments, one database in each, and a database field the
// published schema marks secret.
func exportFixture() *exportOrg {
	account := "ci1"
	return &exportOrg{
		fakeOrg: &fakeOrg{
			account:  api.CloudIdentity{ID: "ci1", Provider: "aws", Label: "prod-account"},
			projects: []types.ConfigurationSummary{{ID: "p1", ProjectName: "web"}},
			envs: []api.Environment{
				{ID: "e2", Name: "staging", Stage: "staging", PlacementMode: "namespace"},
				{ID: "e1", Name: "prod", Stage: "production", PlacementMode: "dedicated", IsDefault: true},
			},
			components: map[string][]api.Component{
				"e1": {{ID: "c1", Kind: "databases", Name: "orders", Status: "ACTIVE", Config: map[string]any{
					"engine": "postgres", "engine_version": "15", "admin_password": "hunter2",
				}}},
				"e2": {{ID: "c2", Kind: "databases", Name: "orders", Status: "ACTIVE", Config: map[string]any{"engine": "postgres"}}},
			},
			fail: map[string]error{},
		},
		settings:   &api.ProjectSettings{ID: "p1", ProjectName: "web", Region: "eu-west-1", CloudIdentityID: &account},
		identities: []api.CloudIdentity{{ID: "ci1", Provider: "aws", Label: "prod-account"}},
		schema: &api.ComponentSchemaDocument{Version: "v1", Kinds: []api.ComponentSchemaKind{{
			Kind: "databases", Fields: []string{"engine", "engine_version", "admin_password"},
			Schema: map[string]any{"properties": map[string]any{
				"engine":         map[string]any{"type": "string"},
				"engine_version": map[string]any{"type": "string"},
				"admin_password": map[string]any{"type": "string", "writeOnly": true},
			}},
		}}},
	}
}

// The exported file opens with the line that names its schema, reads back through Parse, and plans
// against the organization it was exported from as nothing to change. A field the schema marks
// secret is not in it, and the header says so.
func TestBuildExport_RoundTripsAndNamesItsSchema(t *testing.T) {
	org := exportFixture()
	ex, err := BuildExport(org, ExportOptions{Project: "web", All: true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	data, err := ex.Render()
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	if !strings.HasPrefix(text, SchemaComment+"\n") || !strings.HasSuffix(SchemaComment, SchemaURL) {
		t.Errorf("line 1 is not the schema comment:\n%s", text)
	}
	// The header names the field it left out; the document under it does not carry it.
	body := text[strings.Index(text, "\nproject:"):]
	if strings.Contains(text, "hunter2") || strings.Contains(body, "admin_password") {
		t.Errorf("a field the schema marks secret was written:\n%s", text)
	}
	if !strings.Contains(text, "left out admin_password") {
		t.Errorf("the header does not say what was left out:\n%s", text)
	}

	m, err := Parse(data)
	if err != nil {
		t.Fatalf("the exported file does not read back: %v\n%s", err, text)
	}
	m.Normalize()
	if m.Project != "web" || m.Cloud.Account != "prod-account" || len(m.Environments) != 2 || m.Environments[0].Name != "prod" {
		t.Errorf("the file does not describe the project, default environment first: %+v", m)
	}
	plan, err := ComputePlan(org, m, nil)
	if err != nil {
		t.Fatal(err)
	}
	if plan.HasChanges() || plan.Refusal() != nil || len(plan.Unmanaged) != 0 {
		t.Errorf("a file exported from the organization plans as something to change: %+v", plan)
	}
}

// A project or an environment that is not there is a NotFoundError naming what is, so a caller can
// tell it from a read that failed.
func TestBuildExport_WhatIsNotThereIsANotFoundError(t *testing.T) {
	for name, tc := range map[string]struct {
		o    ExportOptions
		says string
	}{
		"a project":      {ExportOptions{Project: "shop", All: true}, `project "shop" not found (have: web)`},
		"an environment": {ExportOptions{Project: "web", Env: "qa"}, `environment "qa" not found in web`},
	} {
		_, err := BuildExport(exportFixture(), tc.o, nil)
		var missing *NotFoundError
		if !errors.As(err, &missing) || !strings.Contains(missing.Error(), tc.says) {
			t.Errorf("%s: %v", name, err)
		}
	}
	empty := exportFixture()
	empty.projects = nil
	var missing *NotFoundError
	if _, err := BuildExport(empty, ExportOptions{Project: "web"}, nil); !errors.As(err, &missing) || !strings.Contains(err.Error(), "has no projects") {
		t.Errorf("an organization with no project: %v", err)
	}

	failing := exportFixture()
	failing.fail["settings"] = errors.New("boom")
	if _, err := BuildExport(failing, ExportOptions{Project: "web", All: true}, nil); err == nil || errors.As(err, &missing) {
		t.Errorf("a read that failed must not read as not found: %v", err)
	}
}

// One environment of several is exported alone, the others are named as left out, and the picker
// is asked only when no flag chose.
func TestBuildExport_OneEnvironment(t *testing.T) {
	ex, err := BuildExport(exportFixture(), ExportOptions{Project: "web", Env: "staging"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(ex.Manifest.Environments) != 1 || ex.Manifest.Environments[0].Name != "staging" {
		t.Fatalf("environments: %+v", ex.Manifest.Environments)
	}
	if notes := strings.Join(ex.Notes, "\n"); !strings.Contains(notes, "environments prod — not exported") {
		t.Errorf("the notes do not name the environment that was left out:\n%s", notes)
	}

	asked := 0
	pick := func(project string, names []string) (string, error) {
		asked++
		if project != "web" || strings.Join(names, ",") != "prod,staging" {
			t.Errorf("the picker was asked about %s %v", project, names)
		}
		return ExportAllEnvironments, nil
	}
	ex, err = BuildExport(exportFixture(), ExportOptions{Project: "web"}, pick)
	if err != nil || asked != 1 || len(ex.Manifest.Environments) != 2 {
		t.Errorf("the picker's \"every environment\": asked %d times, %v", asked, err)
	}
}
