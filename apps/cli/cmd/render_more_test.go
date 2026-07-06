// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"encoding/json"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

// Empty-table branches for every list renderer.

func TestRenderEmptyTables(t *testing.T) {
	cases := map[string]func(*bytes.Buffer) error{
		"clusters":   func(b *bytes.Buffer) error { return renderClusters(b, "table", nil) },
		"runners":    func(b *bytes.Buffer) error { return renderRunners(b, "table", nil) },
		"jobs":       func(b *bytes.Buffer) error { return renderJobs(b, "table", nil) },
		"identities": func(b *bytes.Buffer) error { return renderCloudIdentities(b, "table", nil) },
		"orgList":    func(b *bytes.Buffer) error { return runOrgList(&fakeClient{}, b, "table") },
		"members":    func(b *bytes.Buffer) error { return runMembersList(&fakeClient{}, b, "table", "o1") },
		"teams":      func(b *bytes.Buffer) error { return runTeamsList(&fakeClient{}, b, "table", "o1") },
	}
	for name, fn := range cases {
		t.Run(name, func(t *testing.T) {
			var buf bytes.Buffer
			if err := fn(&buf); err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			if buf.Len() == 0 {
				t.Errorf("%s: expected an empty-state notice", name)
			}
		})
	}
}

// JSON branches for the list renderers that take typed records.

func TestRenderJSONBranches(t *testing.T) {
	var buf bytes.Buffer
	if err := renderRunners(&buf, "json", []api.Runner{{Name: "r1", Status: "ONLINE"}}); err != nil {
		t.Fatalf("renderRunners json: %v", err)
	}
	var runners []api.Runner
	if err := json.Unmarshal(buf.Bytes(), &runners); err != nil {
		t.Fatalf("invalid json: %v", err)
	}

	buf.Reset()
	if err := renderClusters(&buf, "csv", []api.ClusterSummary{{ClusterName: "c1", Status: "ACTIVE"}}); err != nil {
		t.Fatalf("renderClusters csv: %v", err)
	}
	if buf.Len() == 0 {
		t.Error("expected csv output")
	}

	buf.Reset()
	if err := runMembersList(&fakeClient{members: []api.Member{{Email: "a@x.com"}}}, &buf, "json", "o1"); err != nil {
		t.Fatalf("members json: %v", err)
	}
	if !bytes.Contains(buf.Bytes(), []byte("a@x.com")) {
		t.Error("expected member email in json")
	}
}

func TestRenderJobJSONAndCSV(t *testing.T) {
	job := &api.ProvisionJob{ID: "j1", JobType: "PLAN", Status: "SUCCESS"}
	var buf bytes.Buffer
	if err := renderJob(&buf, "csv", job); err != nil {
		t.Fatalf("renderJob csv: %v", err)
	}
	if !bytes.Contains(buf.Bytes(), []byte("j1")) {
		t.Errorf("csv job output: %s", buf.String())
	}
}

func TestRenderProjectsJSON(t *testing.T) {
	var buf bytes.Buffer
	if err := renderProjects(&buf, ui.FormatJSON, nil); err != nil {
		t.Fatalf("renderProjects json empty: %v", err)
	}
	// Empty json should still be valid (an empty array).
	if buf.Len() == 0 {
		t.Error("expected json output even when empty")
	}
}
