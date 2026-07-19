// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"errors"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

func TestRunChartList(t *testing.T) {
	c := &fakeClient{byoCharts: &api.ProjectByoCharts{
		Environment: "production",
		Charts: []api.ByoChart{
			{ID: "payments", RepoURL: "https://github.com/acme/charts", ChartPath: "charts/payments", Ref: "main", Status: "READY", ScanStatus: "done"},
		},
	}}
	var buf bytes.Buffer
	if err := runChartList(c, &buf, "table", "proj", ""); err != nil {
		t.Fatalf("runChartList: %v", err)
	}
	out := buf.String()
	for _, want := range []string{"payments", "charts/payments", "main", "READY", "done"} {
		if !strings.Contains(out, want) {
			t.Errorf("table output missing %q:\n%s", want, out)
		}
	}
}

func TestRunChartListJSON(t *testing.T) {
	c := &fakeClient{byoCharts: &api.ProjectByoCharts{Environment: "prod", Charts: []api.ByoChart{{ID: "payments", ScanStatus: "unscanned"}}}}
	var buf bytes.Buffer
	if err := runChartList(c, &buf, "json", "proj", ""); err != nil {
		t.Fatalf("runChartList json: %v", err)
	}
	if !strings.Contains(buf.String(), `"scan_status": "unscanned"`) {
		t.Errorf("json output unexpected:\n%s", buf.String())
	}
}

func TestRunChartListEmpty(t *testing.T) {
	c := &fakeClient{byoCharts: &api.ProjectByoCharts{Environment: "prod", Charts: nil}}
	var buf bytes.Buffer
	if err := runChartList(c, &buf, "table", "proj", ""); err != nil {
		t.Fatalf("runChartList empty: %v", err)
	}
	if !strings.Contains(buf.String(), "No BYO charts attached") {
		t.Errorf("expected empty notice, got: %q", buf.String())
	}
}

func TestRunChartListError(t *testing.T) {
	c := &fakeClient{err: errors.New("boom")}
	if err := runChartList(c, &bytes.Buffer{}, "table", "proj", ""); err == nil {
		t.Error("expected error to propagate")
	}
}
