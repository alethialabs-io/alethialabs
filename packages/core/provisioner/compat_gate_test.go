// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/compat"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// TestCompatGateBlocksIncompatibleApply is the fail-closed proof for the apply-time
// version-compatibility gate (#1215): a real apply whose config is INCOMPATIBLE per the
// matrix must be refused before `tofu apply`, and only an authorized override may waive
// it. It drives the REAL RunDeployV2 spine against the trivial provider-less module (so
// it needs `tofu` but no docker / no cloud), exactly like the verify-gate wiring test.
//
// The config pins the cluster K8s minor to one Hetzner does NOT offer (matrix records
// hetzner supported = ["1.35"]), so control COMPAT-K8S-CLOUD-HETZNER fails → the gate
// blocks under COMPAT-001.
func TestCompatGateBlocksIncompatibleApply(t *testing.T) {
	if _, err := exec.LookPath("tofu"); err != nil {
		t.Skip("tofu not on PATH — skipping (bare CI without OpenTofu)")
	}

	const failingControl = "COMPAT-K8S-CLOUD-HETZNER"

	newIncompatibleConfig := func(env string) *types.ProjectConfig {
		vc := newLocalProjectConfig("alethia", env)
		// 1.30 is not in the matrix's Hetzner supported set (["1.35"]) → hard fail.
		vc.Cluster.ClusterVersion = "1.30"
		return vc
	}

	modDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(modDir, "main.tf"), []byte(wiringModuleTF), 0o644); err != nil {
		t.Fatal(err)
	}

	t.Run("incompatible config is refused before apply", func(t *testing.T) {
		srv := startTestStateServer(t)
		logw := tLogWriter{t}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()

		result, err := RunDeployV2(ctx, DeployParams{
			ProjectConfig: newIncompatibleConfig("cmp" + shortID(t)),
			Provider:      "hetzner",
			TemplatesDir:  modDir,
			StateBackend:  testStateBackend(srv),
			DryRun:        false,
			Stdout:        logw,
			Stderr:        logw,
		})
		if err == nil {
			t.Fatal("expected the compat gate to BLOCK the apply, got nil error (gate failed OPEN)")
		}
		// The refuse message must name the COMPAT-001 gate and the failing control so an
		// operator knows what to fix or how to authorize an override.
		for _, want := range []string{compat.ControlGateID, failingControl} {
			if !strings.Contains(err.Error(), want) {
				t.Errorf("block error should name %q: %v", want, err)
			}
		}
		// A blocked apply returns no result (nil, err) — nothing was applied.
		if result != nil {
			t.Errorf("expected nil result on a blocked apply, got %#v", result)
		}
	})

	t.Run("authorized override waives the failing control and lets apply proceed", func(t *testing.T) {
		srv := startTestStateServer(t)
		vc := newIncompatibleConfig("ovr" + shortID(t))
		logw := tLogWriter{t}
		ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
		defer cancel()

		// Guaranteed teardown: the override lets the (trivial) apply run, so destroy state.
		t.Cleanup(func() {
			dctx, dcancel := context.WithTimeout(context.Background(), 2*time.Minute)
			defer dcancel()
			if derr := RunDestroy(dctx, DestroyParams{
				ProjectConfig: vc,
				Provider:      "hetzner",
				TemplatesDir:  modDir,
				StateBackend:  testStateBackend(srv),
				Stdout:        logw,
				Stderr:        logw,
			}); derr != nil {
				t.Logf("compat-override teardown (non-fatal): %v", derr)
			}
		})

		result, err := RunDeployV2(ctx, DeployParams{
			ProjectConfig: vc,
			Provider:      "hetzner",
			TemplatesDir:  modDir,
			StateBackend:  testStateBackend(srv),
			DryRun:        false,
			CompatOverride: &compat.Override{
				Controls: []string{failingControl},
				Reason:   "known matrix gap; K8s 1.30 validated manually for this test",
				By:       "alice",
				Expiry:   time.Now().Add(time.Hour),
			},
			Stdout: logw,
			Stderr: logw,
		})
		if err != nil {
			t.Fatalf("expected the override to let the apply proceed, got error: %v", err)
		}
		// The report is still attached and still records the failure (an override waives
		// enforcement; it does not rewrite the verdict). The console renders this honestly.
		if result.CompatReport == nil {
			t.Fatal("CompatReport is nil — the gate must still attach its report under an override")
		}
		if result.CompatReport.Verdict != compat.StatusFail {
			t.Errorf("compat verdict = %q, want fail (the incompatibility is real; only enforcement was waived)", result.CompatReport.Verdict)
		}
		if unresolved := result.CompatReport.Unwaived(&compat.Override{
			Controls: []string{failingControl}, By: "alice", Expiry: time.Now().Add(time.Hour),
		}); len(unresolved) != 0 {
			t.Errorf("override should leave no unwaived failing controls, got %v", unresolved)
		}
	})
}
