// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package tofu

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// planWithSecretOutput writes a provider-less module carrying a marker value, then inits and saves
// a plan file so ShowPlanJSON has a real plan to decode. Provider-less means no network.
//
// The output is deliberately NOT marked sensitive. The defect is that the whole `tofu show -json`
// payload is streamed to the log writer, and a `sensitive = true` output is redacted by tofu itself
// in some positions — which would let a broken fix still pass. A plain value is unambiguously
// present in the JSON, so the assertion measures the streaming, not tofu's redaction.
func planWithSecretOutput(t *testing.T, dir, secret string) string {
	t.Helper()
	cfg := `output "connection_uri" {
  value = "` + secret + `"
}
`
	if err := os.WriteFile(filepath.Join(dir, "main.tf"), []byte(cfg), 0o600); err != nil {
		t.Fatalf("write module: %v", err)
	}
	planFile := filepath.Join(dir, "tfplan")
	for _, args := range [][]string{
		{"init", "-no-color", "-input=false"},
		{"plan", "-no-color", "-input=false", "-out=" + planFile},
	} {
		cmd := exec.Command("tofu", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("tofu %v: %v\n%s", args, err, out)
		}
	}
	return planFile
}

// TestShowPlanJSON_DoesNotLeakPlanIntoLogWriter is #2025's regression test.
//
// terraform-exec's runTerraformCmdJSON tees the child's stdout into both an internal parse buffer
// and the configured cmd.Stdout. Output() was given an io.Discard redirect for exactly that reason;
// ShowPlanFile goes through the same path and never was — so the entire un-redacted plan JSON was
// streamed to the job-log writer on every deploy (deploy.go) and every drift check (drift.go).
//
// Plan JSON carries planned attribute values in plaintext: DB passwords, kubeconfigs, cloud tokens,
// and the decrypted connector secrets categories.Compose merges in.
func TestShowPlanJSON_DoesNotLeakPlanIntoLogWriter(t *testing.T) {
	requireTofuOrSkip(t)

	const secret = "SECRET-PLAN-MARKER-xyz789"
	dir := t.TempDir()
	planFile := planWithSecretOutput(t, dir, secret)

	// logBuf stands in for the deploy/drift JOB-LOG writer — in production the stream that reaches
	// the console job log and execution_metadata. It must never see the plan payload.
	var logBuf bytes.Buffer
	tf, err := NewTofuCLI(context.Background(), "", dir, &logBuf, &logBuf)
	if err != nil {
		t.Fatalf("NewTofuCLI: %v", err)
	}

	plan, err := tf.ShowPlanJSON(context.Background(), planFile)
	if err != nil {
		t.Fatalf("ShowPlanJSON: %v\nlog:%s", err, logBuf.String())
	}

	// RETURNED to the caller: behaviour preserved — the verification gate and the receipt still get
	// the decoded plan. A "fix" that simply stopped decoding would fail here.
	if plan == nil {
		t.Fatal("ShowPlanJSON returned a nil plan; the caller's decode path is broken")
	}

	// NEVER LOGGED.
	if strings.Contains(logBuf.String(), secret) {
		t.Fatalf("SECURITY REGRESSION: plan JSON leaked into the deploy/drift log writer:\n%s", logBuf.String())
	}
}

// TestShowPlanJSON_RestoresLogWriter guards the seam mechanic, the same way the Output() pair does.
// A leaked io.Discard would silently blind every deploy log AFTER the first ShowPlanJSON call —
// and since deploy.go calls it on every deploy, that would be every deploy's apply stream.
func TestShowPlanJSON_RestoresLogWriter(t *testing.T) {
	requireTofuOrSkip(t)

	const secret = "SECRET-PLAN-MARKER-restore"
	dir := t.TempDir()
	planFile := planWithSecretOutput(t, dir, secret)

	var logBuf bytes.Buffer
	tf, err := NewTofuCLI(context.Background(), "", dir, &logBuf, &logBuf)
	if err != nil {
		t.Fatalf("NewTofuCLI: %v", err)
	}
	if _, err := tf.ShowPlanJSON(context.Background(), planFile); err != nil {
		t.Fatalf("ShowPlanJSON: %v", err)
	}

	// A normal lifecycle command must still reach the log writer afterwards.
	if _, err := tf.Validate(context.Background()); err != nil {
		t.Fatalf("Validate after ShowPlanJSON: %v", err)
	}
	if logBuf.Len() == 0 {
		t.Fatal("lifecycle log writer received nothing after ShowPlanJSON() — io.Discard was not restored")
	}
	if strings.Contains(logBuf.String(), secret) {
		t.Fatalf("SECURITY REGRESSION: secret present in log writer:\n%s", logBuf.String())
	}
}
