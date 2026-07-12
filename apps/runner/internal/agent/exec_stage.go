// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/alethialabs-io/alethialabs/packages/core/sandbox"
)

// RunExecStage is the container-child entry point, dispatched from main.go when
// ALETHIA_RUNNER_EXEC_STAGE=1. It runs INSIDE the per-job sandbox container: it reads the
// serialized stage from the RW-mounted workdir, reconstructs the work via the SAME
// run*Stage functions the parent's Passthrough closure calls, and writes result.json back
// for the parent to read. The child IS the isolation boundary — there is no nested sandbox
// and it never holds the runner API client or the parent's theft-target secrets.
func RunExecStage(parent context.Context) error {
	// Graceful cancellation across the container boundary: a mid-flight cancel sends SIGINT
	// to the runtime CLI, which (foreground `docker|podman run` + --init) forwards it here,
	// to the container's main process. Translate that into ctx cancellation so the tofu it
	// runs is SIGINT'd gracefully (finish in-flight resource, write state, release the lock)
	// rather than the Go default of an abrupt process exit that would SIGKILL tofu via
	// Pdeathsig. A second signal within the runtime's grace window still hard-kills the tree.
	ctx, stop := signal.NotifyContext(parent, syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	workDir := os.Getenv("ALETHIA_STAGE_WORKDIR")
	if workDir == "" {
		return fmt.Errorf("ALETHIA_STAGE_WORKDIR is required in exec-stage mode")
	}
	if home := os.Getenv("HOME"); home != "" {
		_ = os.MkdirAll(home, 0o755)
	}

	raw, err := os.ReadFile(filepath.Join(workDir, "stage.json"))
	if err != nil {
		return fmt.Errorf("read stage.json: %w", err)
	}
	var st sandbox.Stage
	if err := json.Unmarshal(raw, &st); err != nil {
		return fmt.Errorf("parse stage.json: %w", err)
	}

	sec := stageSecretsFromEnv()
	switch st.Kind {
	case sandbox.StageDeploy, sandbox.StagePlan:
		var p stageDeployPayload
		if err := json.Unmarshal(st.Payload, &p); err != nil {
			return fmt.Errorf("parse deploy payload: %w", err)
		}
		return runDeployStage(ctx, p, sec, workDir, os.Stdout, os.Stderr)
	case sandbox.StageDestroy:
		var p stageDestroyPayload
		if err := json.Unmarshal(st.Payload, &p); err != nil {
			return fmt.Errorf("parse destroy payload: %w", err)
		}
		return runDestroyStage(ctx, p, sec, workDir, os.Stdout, os.Stderr)
	case sandbox.StageDrift:
		var p stageDriftPayload
		if err := json.Unmarshal(st.Payload, &p); err != nil {
			return fmt.Errorf("parse drift payload: %w", err)
		}
		return runDriftStage(ctx, p, sec, workDir, os.Stdout, os.Stderr)
	case sandbox.StageChartScan:
		var p stageChartScanPayload
		if err := json.Unmarshal(st.Payload, &p); err != nil {
			return fmt.Errorf("parse chart-scan payload: %w", err)
		}
		return runChartScanStage(ctx, p, workDir, os.Stdout, os.Stderr)
	case sandbox.StageIacScan:
		var p stageIacScanPayload
		if err := json.Unmarshal(st.Payload, &p); err != nil {
			return fmt.Errorf("parse iac-scan payload: %w", err)
		}
		return runIacScanStage(ctx, p, workDir, os.Stdout, os.Stderr)
	default:
		return fmt.Errorf("unknown stage kind %q", st.Kind)
	}
}

// newJobWorkDir creates a per-job workdir (absolute path) the container mounts RW at the
// identical path; stage.json / result.json / the child HOME live under it.
func newJobWorkDir(jobID string) (string, error) {
	safe := sanitizeForPath(jobID)
	return os.MkdirTemp("", "alethia-stage-"+safe+"-*")
}

func sanitizeForPath(s string) string {
	out := make([]rune, 0, len(s))
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			out = append(out, r)
		default:
			out = append(out, '-')
		}
	}
	return string(out)
}
