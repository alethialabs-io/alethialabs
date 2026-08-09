// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	sandboxpkg "github.com/alethialabs-io/alethialabs/packages/core/sandbox"
)

// stubSandbox writes a canned result.json into the workdir instead of running the stage.
type stubSandbox struct{ result string }

func (s stubSandbox) Run(ctx context.Context, spec sandboxpkg.Spec, job sandboxpkg.Job) error {
	return os.WriteFile(filepath.Join(spec.WorkDir, "result.json"), []byte(s.result), 0o600)
}

// planModeAPI captures the on-disk mode of the plan artifact the runner hands to the uploader.
// It embeds mockAPI (same package) and overrides only UploadPlanArtifact.
type planModeAPI struct {
	*mockAPI
	mode os.FileMode
}

func (p *planModeAPI) UploadPlanArtifact(jobID, filePath string) error {
	info, err := os.Stat(filePath)
	if err != nil {
		return err
	}
	p.mode = info.Mode().Perm()
	return nil
}

// The tofu plan artifact is staged in the shared temp dir for the full duration of its upload,
// and a plan file carries every sensitive resource attribute in cleartext. utils.SecretFileMode's
// doc names plan material as 0600-only; this pins that the staged file is owner-only (#2015).
func TestPlanArtifactWrittenOwnerOnly(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("TMPDIR", tmp)
	t.Setenv("ALETHIA_SANDBOX_BACKEND", "")
	t.Setenv("ALETHIA_SANDBOX_ENFORCE_MANAGED", "")

	api := &planModeAPI{mockAPI: &mockAPI{}}
	w := NewWithAPI(Config{Operator: "self", AlethiaURL: "https://console.test"}, api)
	w.sandbox = stubSandbox{result: `{"plan_result":{"PlanFileBytes":"c2VjcmV0LXBsYW4="}}`}

	job := &Job{ID: "job-plan-mode", JobType: "PLAN", ConfigSnapshot: map[string]any{"provider": "aws"}}
	stdout := NewJobLogger(api, job.ID, "STDOUT")
	stderr := NewJobLogger(api, job.ID, "STDERR")
	if err := w.executePlan(context.Background(), job, "aws", nil, nil, stdout, stderr); err != nil {
		t.Fatalf("executePlan: %v", err)
	}
	stdout.Close()
	stderr.Close()

	if api.mode == 0 {
		t.Fatalf("plan artifact was never uploaded — the test did not reach the write")
	}
	if api.mode&0o077 != 0 {
		t.Fatalf("plan artifact written with mode %#o (group/world readable); "+
			"utils.SecretFileMode requires %#o for plan material", api.mode, 0o600)
	}
}
