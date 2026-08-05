// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// TestFormatJobStatus covers the status styling used by `--wait` and `jobs logs`:
// every known status keeps its own text, and an unknown one passes through.
func TestFormatJobStatus(t *testing.T) {
	for _, status := range []string{"QUEUED", "CLAIMED", "PROCESSING", "SUCCESS", "FAILED", "CANCELLED", "SOMETHING_NEW"} {
		t.Run(status, func(t *testing.T) {
			got := formatJobStatus(status)
			if !strings.Contains(got, status) {
				t.Errorf("formatJobStatus(%q) = %q; the status text must survive styling", status, got)
			}
		})
	}
}

// TestJobColumnsMatchRowWidth covers the TUI table projection: jobRows must emit
// exactly one cell per declared column, or the Bubble Tea table renders skewed.
func TestJobColumnsMatchRowWidth(t *testing.T) {
	cols := jobColumns()
	if len(cols) == 0 {
		t.Fatal("jobColumns returned no columns")
	}
	started := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	completed := started.Add(90 * time.Second)
	rows := jobRows([]api.ProvisionJob{
		{ID: "j1", JobType: "DEPLOY", Status: "SUCCESS", ProjectName: "web", RunnerName: "r1",
			CreatedAt: started, StartedAt: &started, CompletedAt: &completed},
		{ID: "j2", JobType: "PLAN", Status: "QUEUED", CreatedAt: started},
	})
	if len(rows) != 2 {
		t.Fatalf("jobRows returned %d rows, want 2", len(rows))
	}
	for i, r := range rows {
		if len(r) != len(cols) {
			t.Errorf("row %d has %d cells, want %d (one per column)", i, len(r), len(cols))
		}
	}
	if rows[0][0] != "DEPLOY" && rows[0][0] == "" {
		t.Errorf("row 0 type cell is empty: %v", rows[0])
	}
}

// TestJobRowsEmpty covers the empty-page projection.
func TestJobRowsEmpty(t *testing.T) {
	if got := jobRows(nil); len(got) != 0 {
		t.Errorf("jobRows(nil) = %v, want no rows", got)
	}
}

// TestProjectSummaryRows covers the csv projection of `project get`: the scalar
// fields are always present and the timestamp row only appears when set.
func TestProjectSummaryRows(t *testing.T) {
	base := types.Configuration{
		ID:                "cfg-1",
		ProjectName:       "web",
		EnvironmentStage:  types.EnvironmentStage("development"),
		ContainerPlatform: "eks",
		CloudAccountID:    "acct-1",
		Region:            "eu-west-1",
		IacVersion:        "1.9.0",
	}

	rows := projectSummaryRows(base)
	if len(rows) != 7 {
		t.Fatalf("projectSummaryRows without a timestamp returned %d rows, want 7", len(rows))
	}
	fields := map[string]string{}
	for _, r := range rows {
		if len(r) != 2 {
			t.Fatalf("row %v is not a field/value pair", r)
		}
		fields[r[0]] = r[1]
	}
	for field, want := range map[string]string{
		"ID":          "cfg-1",
		"Project":     "web",
		"Environment": "development",
		"Region":      "eu-west-1",
		"IaC Version": "1.9.0",
	} {
		if fields[field] != want {
			t.Errorf("field %q = %q, want %q", field, fields[field], want)
		}
	}

	withTime := base
	withTime.UpdatedAt = time.Date(2026, 3, 4, 5, 6, 7, 0, time.UTC)
	rows = projectSummaryRows(withTime)
	if len(rows) != 8 {
		t.Fatalf("projectSummaryRows with a timestamp returned %d rows, want 8", len(rows))
	}
	last := rows[len(rows)-1]
	if last[0] != "Last Updated" || last[1] != "2026-03-04 05:06:07" {
		t.Errorf("last row = %v, want the formatted Last Updated row", last)
	}
}
