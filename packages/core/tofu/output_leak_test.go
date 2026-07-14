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

// requireTofuOrSkip skips when no `tofu` binary is available so the test stays
// hermetic in CI images that don't ship OpenTofu (mirrors provisioner/probe_test.go).
func requireTofuOrSkip(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("tofu"); err != nil {
		t.Skip("tofu not on PATH — skipping the output-leak test")
	}
}

// applyOutputOnlyModule writes a provider-less module whose single (sensitive) output is a
// literal secret, then inits + applies it with a local backend so `tofu output -json` has a
// real state to read. Provider-less means init/apply need no network.
func applyOutputOnlyModule(t *testing.T, dir, secret string) {
	t.Helper()
	cfg := `output "kubeconfig" {
  value     = "` + secret + `"
  sensitive = true
}
`
	if err := os.WriteFile(filepath.Join(dir, "main.tf"), []byte(cfg), 0o600); err != nil {
		t.Fatalf("write module: %v", err)
	}
	for _, args := range [][]string{
		{"init", "-no-color", "-input=false"},
		{"apply", "-no-color", "-input=false", "-auto-approve"},
	} {
		cmd := exec.Command("tofu", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("tofu %v: %v\n%s", args, err, out)
		}
	}
}

// TestOutput_DoesNotLeakSensitiveValuesToLogWriter is the security regression test for
// SEC-TFOUTPUT-SCRUB (follow-up to B2.2 #457). It proves that TofuCLI.Output — the single
// seam every deploy/drift/probe `tf.Output` call funnels through — returns the sensitive
// output value to the caller via the map while NEVER streaming it to the configured
// lifecycle log writer. Without the fix, terraform-exec tees `output -json` (raw secrets
// included) into cmd.Stdout, so the deploy/drift job-log writer would receive the kubeconfig.
func TestOutput_DoesNotLeakSensitiveValuesToLogWriter(t *testing.T) {
	requireTofuOrSkip(t)

	const secret = "SECRET-KUBECONFIG-MARKER-abc123"
	dir := t.TempDir()
	applyOutputOnlyModule(t, dir, secret)

	// logBuf stands in for the deploy/drift JOB-LOG writer (in prod this is the stream
	// that reaches the console + execution_metadata). It must never see the secret.
	var logBuf bytes.Buffer
	tf, err := NewTofuCLI(context.Background(), "", dir, &logBuf, &logBuf)
	if err != nil {
		t.Fatalf("NewTofuCLI: %v", err)
	}

	outputs, err := tf.Output(context.Background())
	if err != nil {
		t.Fatalf("Output: %v\nlog:%s", err, logBuf.String())
	}

	// RETURNED to the caller: the deploy/drift logic (kubeconfig → ConfigureKubeconfig,
	// argocd.BuildFromOutputs) still gets the value — behavior preserved.
	if got, _ := outputs["kubeconfig"].(string); got != secret {
		t.Fatalf("kubeconfig output not returned to caller: got %q, want %q", got, secret)
	}

	// NEVER-LOGGED: the sensitive value must not appear in the lifecycle log writer.
	if strings.Contains(logBuf.String(), secret) {
		t.Fatalf("SECURITY REGRESSION: sensitive output leaked into the deploy/drift log writer:\n%s", logBuf.String())
	}
}

// TestOutput_RestoresLogWriterAfterRead guards the seam mechanic: Output redirects the tofu
// stdout to io.Discard for the read, then must RESTORE the lifecycle writer so a subsequent
// lifecycle command (plan/apply/destroy) still streams its progress to the job log. A leaked
// io.Discard would silently blind the deploy/drift logs after the first Output() call.
func TestOutput_RestoresLogWriterAfterRead(t *testing.T) {
	requireTofuOrSkip(t)

	const secret = "SECRET-KUBECONFIG-MARKER-restore"
	dir := t.TempDir()
	applyOutputOnlyModule(t, dir, secret)

	var logBuf bytes.Buffer
	tf, err := NewTofuCLI(context.Background(), "", dir, &logBuf, &logBuf)
	if err != nil {
		t.Fatalf("NewTofuCLI: %v", err)
	}
	if _, err := tf.Output(context.Background()); err != nil {
		t.Fatalf("Output: %v", err)
	}

	// After Output(), a normal lifecycle command must still reach the log writer. `validate`
	// is a cheap, side-effect-free command that prints to the configured stdout.
	if _, err := tf.Validate(context.Background()); err != nil {
		t.Fatalf("Validate after Output: %v", err)
	}
	if logBuf.Len() == 0 {
		t.Fatal("lifecycle log writer received nothing after Output() — io.Discard was not restored")
	}
	// And still no secret from either the Output read or the validate chatter.
	if strings.Contains(logBuf.String(), secret) {
		t.Fatalf("SECURITY REGRESSION: secret present in log writer:\n%s", logBuf.String())
	}
}
