// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

// --- project create ---

func sampleProject() *api.Project {
	return &api.Project{
		ID: "p1", ProjectName: "api", Slug: "api", Region: "eu-west-1",
		IacVersion: "1.11.4", CloudProvider: "aws",
		EnvironmentStage: "development", Status: "DRAFT",
	}
}

func TestRunProjectCreateTable(t *testing.T) {
	var buf bytes.Buffer
	f := &fakeClient{createdProj: sampleProject()}
	params := api.CreateProjectParams{ProjectName: "api", Region: "eu-west-1", CloudIdentityID: "ci1"}
	if err := runProjectCreate(f, &buf, "table", params); err != nil {
		t.Fatalf("runProjectCreate: %v", err)
	}
	if f.createdProjP.ProjectName != "api" || f.createdProjP.CloudIdentityID != "ci1" {
		t.Errorf("params not forwarded: %+v", f.createdProjP)
	}
	for _, want := range []string{"api", "AWS", "eu-west-1", "DRAFT", "p1"} {
		if !strings.Contains(buf.String(), want) {
			t.Errorf("create card missing %q:\n%s", want, buf.String())
		}
	}
}

func TestRunProjectCreateNoProvider(t *testing.T) {
	var buf bytes.Buffer
	p := sampleProject()
	p.CloudProvider = ""
	if err := runProjectCreate(&fakeClient{createdProj: p}, &buf, "table", api.CreateProjectParams{}); err != nil {
		t.Fatalf("runProjectCreate: %v", err)
	}
	// No provider renders the dash glyph, not "AWS".
	if strings.Contains(buf.String(), "AWS") {
		t.Errorf("unexpected provider: %s", buf.String())
	}
}

func TestRunProjectCreateJSON(t *testing.T) {
	var buf bytes.Buffer
	if err := runProjectCreate(&fakeClient{createdProj: sampleProject()}, &buf, "json", api.CreateProjectParams{}); err != nil {
		t.Fatalf("runProjectCreate json: %v", err)
	}
	var got api.Project
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatalf("invalid json: %v\n%s", err, buf.String())
	}
	if got.ID != "p1" || got.Slug != "api" {
		t.Errorf("unexpected project json: %+v", got)
	}
}

func TestRunProjectCreateError(t *testing.T) {
	var buf bytes.Buffer
	if err := runProjectCreate(&fakeClient{err: errBoom}, &buf, "table", api.CreateProjectParams{}); err == nil {
		t.Error("expected error propagated")
	}
}

// --- project env ---

func sampleEnvironments() []api.Environment {
	region := "us-east-1"
	return []api.Environment{
		{ID: "e1", Name: "development", Stage: "development", Status: "DRAFT", IsDefault: true, Region: nil},
		{ID: "e2", Name: "staging", Stage: "staging", Status: "ACTIVE", IsDefault: false, Region: &region},
	}
}

func TestEnvRows(t *testing.T) {
	rows := envRows(sampleEnvironments())
	if len(rows) != 2 {
		t.Fatalf("expected 2 rows, got %d", len(rows))
	}
	// Default env: brand marker + dash region.
	if rows[0][3] != ui.SymbolDefault || rows[0][4] != ui.SymbolDash {
		t.Errorf("unexpected default row: %+v", rows[0])
	}
	if rows[1][3] != ui.SymbolDash || rows[1][4] != "us-east-1" {
		t.Errorf("unexpected named row: %+v", rows[1])
	}
}

func TestRunProjectEnvListTable(t *testing.T) {
	var buf bytes.Buffer
	f := &fakeClient{environments: sampleEnvironments()}
	if err := runProjectEnvList(f, &buf, "table", "api"); err != nil {
		t.Fatalf("runProjectEnvList: %v", err)
	}
	if f.envProject != "api" {
		t.Errorf("project not forwarded: %q", f.envProject)
	}
	for _, want := range []string{"development", "staging", "us-east-1"} {
		if !strings.Contains(buf.String(), want) {
			t.Errorf("env list missing %q:\n%s", want, buf.String())
		}
	}
}

func TestRunProjectEnvListJSON(t *testing.T) {
	var buf bytes.Buffer
	if err := runProjectEnvList(&fakeClient{environments: sampleEnvironments()}, &buf, "json", "api"); err != nil {
		t.Fatalf("json: %v", err)
	}
	var got []api.Environment
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatalf("invalid json: %v", err)
	}
	if len(got) != 2 {
		t.Errorf("expected 2 envs, got %d", len(got))
	}
}

func TestRunProjectEnvListEmpty(t *testing.T) {
	var buf bytes.Buffer
	if err := runProjectEnvList(&fakeClient{environments: nil}, &buf, "table", "api"); err != nil {
		t.Fatalf("empty: %v", err)
	}
	if !strings.Contains(buf.String(), "No environments") {
		t.Errorf("expected empty notice: %s", buf.String())
	}
}

func TestRunProjectEnvListError(t *testing.T) {
	var buf bytes.Buffer
	if err := runProjectEnvList(&fakeClient{err: errBoom}, &buf, "table", "api"); err == nil {
		t.Error("expected error propagated")
	}
}

func TestRunProjectEnvAdd(t *testing.T) {
	var buf bytes.Buffer
	f := &fakeClient{}
	if err := runProjectEnvAdd(f, &buf, "api", "staging", "staging", "us-east-1"); err != nil {
		t.Fatalf("runProjectEnvAdd: %v", err)
	}
	if f.addedEnvName != "staging" || f.addedEnvStage != "staging" || f.addedEnvRegion != "us-east-1" {
		t.Errorf("args not recorded: %+v", f)
	}
	if !strings.Contains(buf.String(), "Added environment staging") {
		t.Errorf("expected success line: %s", buf.String())
	}
}

func TestRunProjectEnvAddError(t *testing.T) {
	var buf bytes.Buffer
	if err := runProjectEnvAdd(&fakeClient{err: errBoom}, &buf, "api", "x", "development", ""); err == nil {
		t.Error("expected error propagated")
	}
}

// --- component kinds ---

func TestRunComponentKinds(t *testing.T) {
	var buf bytes.Buffer
	if err := runComponentKinds(&buf, "table"); err != nil {
		t.Fatalf("runComponentKinds: %v", err)
	}
	for _, want := range []string{"network", "singleton", "databases", "multi"} {
		if !strings.Contains(buf.String(), want) {
			t.Errorf("kinds missing %q:\n%s", want, buf.String())
		}
	}
}

func TestKindRowsCardinality(t *testing.T) {
	rows := kindRows()
	if len(rows) != len(componentKinds) {
		t.Fatalf("expected %d rows, got %d", len(componentKinds), len(rows))
	}
	for _, r := range rows {
		want := "multi"
		if singletonKinds[r[0]] {
			want = "singleton"
		}
		if r[1] != want {
			t.Errorf("kind %s: got cardinality %q want %q", r[0], r[1], want)
		}
	}
}

// --- component list ---

func sampleComponents() []api.Component {
	ci := "ci-9"
	return []api.Component{
		{ID: "c1", Kind: "network", Name: "network", Status: "ACTIVE", CloudIdentityID: nil, Config: map[string]interface{}{"cidr_block": "10.0.0.0/16"}},
		{ID: "c2", Kind: "databases", Name: "main", Status: "", CloudIdentityID: &ci, Config: map[string]interface{}{"engine": "postgres"}},
	}
}

func TestComponentRows(t *testing.T) {
	rows := componentRows(sampleComponents())
	if rows[0][3] != ui.SymbolDash {
		t.Errorf("inherited identity should be dash: %+v", rows[0])
	}
	if rows[0][2] != "ACTIVE" {
		t.Errorf("unexpected status: %+v", rows[0])
	}
	if rows[1][3] != "ci-9" {
		t.Errorf("explicit identity not shown: %+v", rows[1])
	}
	if rows[1][2] != ui.SymbolDash {
		t.Errorf("empty status should be dash: %+v", rows[1])
	}
}

func TestRunComponentListTable(t *testing.T) {
	var buf bytes.Buffer
	f := &fakeClient{components: sampleComponents()}
	if err := runComponentList(f, &buf, "table", "api", "databases", "prod"); err != nil {
		t.Fatalf("runComponentList: %v", err)
	}
	if f.listCompProj != "api" || f.listCompKind != "databases" || f.listCompEnv != "prod" {
		t.Errorf("filters not forwarded: %+v", f)
	}
	for _, want := range []string{"network", "databases", "main"} {
		if !strings.Contains(buf.String(), want) {
			t.Errorf("component list missing %q:\n%s", want, buf.String())
		}
	}
}

func TestRunComponentListJSON(t *testing.T) {
	var buf bytes.Buffer
	if err := runComponentList(&fakeClient{components: sampleComponents()}, &buf, "json", "api", "", ""); err != nil {
		t.Fatalf("json: %v", err)
	}
	var got []api.Component
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatalf("invalid json: %v", err)
	}
	if len(got) != 2 || got[1].Config["engine"] != "postgres" {
		t.Errorf("unexpected components json: %+v", got)
	}
}

func TestRunComponentListEmpty(t *testing.T) {
	var buf bytes.Buffer
	if err := runComponentList(&fakeClient{components: nil}, &buf, "table", "api", "", ""); err != nil {
		t.Fatalf("empty: %v", err)
	}
	if !strings.Contains(buf.String(), "No components") {
		t.Errorf("expected empty notice: %s", buf.String())
	}
}

func TestRunComponentListError(t *testing.T) {
	var buf bytes.Buffer
	if err := runComponentList(&fakeClient{err: errBoom}, &buf, "table", "api", "", ""); err == nil {
		t.Error("expected error propagated")
	}
}

// --- component add ---

func TestParseSetValues(t *testing.T) {
	fields, err := parseSetValues([]string{
		"engine=postgres",
		"port=5432",
		"iam_auth=true",
		"instance_types=[\"t3.medium\",\"t3.large\"]",
	})
	if err != nil {
		t.Fatalf("parseSetValues: %v", err)
	}
	if fields["engine"] != "postgres" {
		t.Errorf("string coercion wrong: %#v", fields["engine"])
	}
	if v, ok := fields["port"].(float64); !ok || v != 5432 {
		t.Errorf("number coercion wrong: %#v", fields["port"])
	}
	if v, ok := fields["iam_auth"].(bool); !ok || !v {
		t.Errorf("bool coercion wrong: %#v", fields["iam_auth"])
	}
	arr, ok := fields["instance_types"].([]interface{})
	if !ok || len(arr) != 2 || arr[0] != "t3.medium" {
		t.Errorf("array coercion wrong: %#v", fields["instance_types"])
	}
}

func TestParseSetValuesInvalid(t *testing.T) {
	if _, err := parseSetValues([]string{"noequalsign"}); err == nil {
		t.Error("expected error for malformed --set")
	}
	if _, err := parseSetValues([]string{"=value"}); err == nil {
		t.Error("expected error for empty key")
	}
}

func TestCoerceSetValue(t *testing.T) {
	if v := coerceSetValue("plain"); v != "plain" {
		t.Errorf("plain string: %#v", v)
	}
	if v := coerceSetValue("null"); v != nil {
		t.Errorf("null: %#v", v)
	}
	if v, ok := coerceSetValue("false").(bool); !ok || v {
		t.Errorf("false: %#v", coerceSetValue("false"))
	}
}

func TestRunComponentAdd(t *testing.T) {
	var buf bytes.Buffer
	f := &fakeClient{}
	fields := map[string]interface{}{"engine": "postgres"}
	if err := runComponentAdd(f, &buf, "api", "databases", "main", fields); err != nil {
		t.Fatalf("runComponentAdd: %v", err)
	}
	if f.addCompKind != "databases" || f.addCompName != "main" {
		t.Errorf("args not recorded: %+v", f)
	}
	if !reflect.DeepEqual(f.addCompFields, fields) {
		t.Errorf("fields not forwarded: %+v", f.addCompFields)
	}
	if !strings.Contains(buf.String(), "Added databases component") {
		t.Errorf("expected success line: %s", buf.String())
	}
}

func TestRunComponentAddMissingKind(t *testing.T) {
	var buf bytes.Buffer
	if err := runComponentAdd(&fakeClient{}, &buf, "api", "", "", nil); err == nil {
		t.Error("expected error when kind is empty")
	}
}

func TestRunComponentAddError(t *testing.T) {
	var buf bytes.Buffer
	if err := runComponentAdd(&fakeClient{err: errBoom}, &buf, "api", "databases", "main", nil); err == nil {
		t.Error("expected error propagated")
	}
}

// --- component remove ---

func TestRunComponentRemoveSingleton(t *testing.T) {
	var buf bytes.Buffer
	f := &fakeClient{}
	// A name is passed but must be cleared for a singleton kind.
	if err := runComponentRemove(f, &buf, "api", "network", "ignored"); err != nil {
		t.Fatalf("runComponentRemove: %v", err)
	}
	if f.rmCompName != "" {
		t.Errorf("singleton name should be cleared, got %q", f.rmCompName)
	}
	if f.rmCompKind != "network" {
		t.Errorf("kind not forwarded: %q", f.rmCompKind)
	}
}

func TestRunComponentRemoveNamed(t *testing.T) {
	var buf bytes.Buffer
	f := &fakeClient{}
	if err := runComponentRemove(f, &buf, "api", "databases", "main"); err != nil {
		t.Fatalf("runComponentRemove: %v", err)
	}
	if f.rmCompName != "main" {
		t.Errorf("named component name should be kept, got %q", f.rmCompName)
	}
	if !strings.Contains(buf.String(), "Component removed") {
		t.Errorf("expected success line: %s", buf.String())
	}
}

func TestRunComponentRemoveError(t *testing.T) {
	var buf bytes.Buffer
	if err := runComponentRemove(&fakeClient{err: errBoom}, &buf, "api", "databases", "main"); err == nil {
		t.Error("expected error propagated")
	}
}

// --- currentProject ---

func TestCurrentProject(t *testing.T) {
	c := &cobra.Command{Use: "x"}
	c.Flags().String("project", "", "")
	if _, err := currentProject(c); err == nil {
		t.Error("expected error when --project unset")
	}
	if err := c.Flags().Set("project", "api"); err != nil {
		t.Fatalf("set flag: %v", err)
	}
	got, err := currentProject(c)
	if err != nil || got != "api" {
		t.Errorf("currentProject = %q, %v", got, err)
	}
}
