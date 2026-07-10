// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/sandbox"
)

// TestRunExecStage_ChartScan exercises the container-child dispatch END-TO-END in-process:
// it writes a stage.json (as the container backend would), runs RunExecStage (the child
// entry), and asserts result.json comes back with a verify.Report — proving the
// stage.json → dispatch → run*Stage → result.json contract independent of docker. Needs
// helm on PATH.
func TestRunExecStage_ChartScan(t *testing.T) {
	if _, err := exec.LookPath("helm"); err != nil {
		t.Skip("helm not on PATH")
	}

	workDir := t.TempDir()
	chartDir := filepath.Join(workDir, "clone", "chart")
	if err := os.MkdirAll(filepath.Join(chartDir, "templates"), 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(rel, content string) {
		if err := os.WriteFile(filepath.Join(chartDir, rel), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("Chart.yaml", "apiVersion: v2\nname: scan\nversion: 0.1.0\n")
	write("values.yaml", "greeting: hello\n")
	write("templates/cm.yaml", `apiVersion: v1
kind: ConfigMap
metadata:
  name: scan-cm
data:
  msg: {{ .Values.greeting | quote }}
`)

	payload := stageChartScanPayload{ChartDir: chartDir, JobID: "job-1"}
	stageBytes, err := json.Marshal(sandbox.Stage{Kind: sandbox.StageChartScan, Payload: mustJSON(t, payload)})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workDir, "stage.json"), stageBytes, 0o600); err != nil {
		t.Fatal(err)
	}

	t.Setenv("ALETHIA_STAGE_WORKDIR", workDir)
	t.Setenv("HOME", filepath.Join(workDir, "home"))

	if err := RunExecStage(context.Background()); err != nil {
		t.Fatalf("RunExecStage: %v", err)
	}

	report, err := readVerifyReport(workDir)
	if err != nil {
		t.Fatalf("readVerifyReport: %v", err)
	}
	if report == nil {
		t.Fatal("expected a verify.Report in result.json, got nil")
	}
	if report.Verdict == "" {
		t.Error("verify report has no verdict")
	}
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
