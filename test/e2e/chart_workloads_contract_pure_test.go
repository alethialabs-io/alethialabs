// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// BYO chart-workload CONTRACT-LOCK (W5 Path A — Option B), Go half. Unlike the W1 services contract
// (whose fixture the console vitest generates), here the Go extractor IS the wire's source: the
// CHART_SCAN runner extracts []types.ChartWorkload from a chart's rendered manifests and posts it on
// execution_metadata.chart_workloads; the console consumes that JSON verbatim. So this test freezes
// the extractor's output as fixtures/chart_workloads.json (the golden byte-compare catches any
// Go-side shape/rename drift), and the console vitest
// (apps/console/tests/e2e-fixtures/chart-workloads-contract.test.ts) proves that exact wire parses
// against the TS zod + interfaces — the two together lock the cross-language contract.
package e2e

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/k8s"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

const chartWorkloadsFixture = "chart_workloads.json"

// extractChartGolden runs the real extractor over the golden render (testdata/chart_render.yaml).
func extractChartGolden(t *testing.T) []types.ChartWorkload {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "chart_render.yaml"))
	if err != nil {
		t.Fatalf("read testdata/chart_render.yaml: %v", err)
	}
	resources, err := k8s.Decode(raw)
	if err != nil {
		t.Fatalf("decode golden render: %v", err)
	}
	return k8s.Workloads(resources)
}

func TestChartWorkloadsContract_Golden(t *testing.T) {
	extracted := extractChartGolden(t)
	wire, err := json.MarshalIndent(extracted, "", "\t")
	if err != nil {
		t.Fatalf("marshal extracted: %v", err)
	}
	wire = append(wire, '\n')
	path := filepath.Join("fixtures", chartWorkloadsFixture)

	if os.Getenv("UPDATE_FIXTURES") == "1" {
		if err := os.WriteFile(path, wire, 0o644); err != nil {
			t.Fatalf("write fixture: %v", err)
		}
		t.Logf("regenerated %s", path)
		return
	}

	committed, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s (regenerate: UPDATE_FIXTURES=1 go test ./ -run ChartWorkloadsContract): %v", path, err)
	}
	if string(committed) != string(wire) {
		t.Errorf("extractor wire drifted from the committed fixture.\n--- committed ---\n%s\n--- extracted ---\n%s\nregenerate: UPDATE_FIXTURES=1 go test ./ -run ChartWorkloadsContract", committed, wire)
	}
}

func TestChartWorkloadsContract_FieldsSurviveDecode(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("fixtures", chartWorkloadsFixture))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var wl []types.ChartWorkload
	if err := json.Unmarshal(raw, &wl); err != nil {
		t.Fatalf("fixture does not unmarshal into []ChartWorkload: %v", err)
	}
	if len(wl) != 2 {
		t.Fatalf("expected 2 workloads (web, worker; Service skipped), got %d", len(wl))
	}
	web, worker := wl[0], wl[1]

	// web — the maximal Deployment: every rendered field populated, so every zero value here means
	// the wire key no longer reaches the Go field (renamed/retyped upstream).
	if web.Name != "web" || web.WorkloadKind != "deployment" {
		t.Errorf("web identity drifted: name=%q kind=%q", web.Name, web.WorkloadKind)
	}
	if web.Rendered.Image != "ghcr.io/acme/web:1.2.3" {
		t.Errorf("web image drifted: %q", web.Rendered.Image)
	}
	if len(web.Rendered.Ports) != 2 ||
		web.Rendered.Ports[0].Name != "http" || web.Rendered.Ports[0].ContainerPort != 8080 || web.Rendered.Ports[0].Protocol != "TCP" ||
		web.Rendered.Ports[1].Name != "metrics" || web.Rendered.Ports[1].ContainerPort != 9090 {
		t.Errorf("web ports drifted: %+v", web.Rendered.Ports)
	}
	if len(web.Rendered.EnvKeys) != 2 || web.Rendered.EnvKeys[0] != "LOG_LEVEL" || web.Rendered.EnvKeys[1] != "DB_URL" {
		t.Errorf("web env_keys drifted (names only): %v", web.Rendered.EnvKeys)
	}
	if web.Rendered.Resources == nil ||
		web.Rendered.Resources.Requests != (types.ServiceResourceQuantities{CPU: "100m", Memory: "128Mi"}) ||
		web.Rendered.Resources.Limits != (types.ServiceResourceQuantities{CPU: "1", Memory: "512Mi"}) {
		t.Errorf("web resources drifted: %+v", web.Rendered.Resources)
	}
	if web.Rendered.Replicas == nil || *web.Rendered.Replicas != 3 {
		t.Errorf("web replicas drifted: %v", web.Rendered.Replicas)
	}

	// worker — the minimal Job: image only; ports/env_keys empty (non-nil → []), resources/replicas
	// omitted (decode NULL/absent → nil).
	if worker.Name != "worker" || worker.WorkloadKind != "job" {
		t.Errorf("worker identity drifted: name=%q kind=%q", worker.Name, worker.WorkloadKind)
	}
	if worker.Rendered.Image != "ghcr.io/acme/worker:4.5.6" {
		t.Errorf("worker image drifted: %q", worker.Rendered.Image)
	}
	if worker.Rendered.Resources != nil {
		t.Errorf("worker resources must decode absent → nil, got %+v", worker.Rendered.Resources)
	}
	if worker.Rendered.Replicas != nil {
		t.Errorf("worker (job) replicas must be nil, got %v", worker.Rendered.Replicas)
	}
	if len(worker.Rendered.Ports) != 0 || len(worker.Rendered.EnvKeys) != 0 {
		t.Errorf("worker ports/env_keys must be empty: %+v / %v", worker.Rendered.Ports, worker.Rendered.EnvKeys)
	}
}

func TestChartWorkloadsContract_NoOrphanGoKeys(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("fixtures", chartWorkloadsFixture))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var wires []map[string]json.RawMessage
	if err := json.Unmarshal(raw, &wires); err != nil {
		t.Fatalf("fixture is not an array of objects: %v", err)
	}
	var wl []types.ChartWorkload
	if err := json.Unmarshal(raw, &wl); err != nil {
		t.Fatalf("decode into []ChartWorkload: %v", err)
	}
	for i, w := range wl {
		out, err := json.Marshal(w)
		if err != nil {
			t.Fatalf("re-marshal workload %d: %v", i, err)
		}
		var got map[string]json.RawMessage
		if err := json.Unmarshal(out, &got); err != nil {
			t.Fatalf("re-decode workload %d: %v", i, err)
		}
		for k := range got {
			if _, ok := wires[i][k]; !ok {
				t.Errorf("workload %d (%s): Go struct emits key %q absent from the wire fixture (field removed/renamed upstream?)", i, w.Name, k)
			}
		}
	}
}
