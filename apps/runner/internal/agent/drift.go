// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/alethialabs-io/alethialabs/packages/core/provisioner"
	"github.com/alethialabs-io/alethialabs/packages/core/sandbox"
)

// executeDriftDetection handles a DETECT_DRIFT job: it runs `tofu plan
// -refresh-only` for the environment (cloud creds already activated in
// executeJob), computes a drift Posture, and stores it on
// execution_metadata.drift_posture. It mutates nothing in the cloud.
func (w *Runner) executeDriftDetection(ctx context.Context, job *Job, provider string, identity *CloudIdentity, stdout, stderr *JobLogger) error {
	vc, err := snapshotToProjectConfig(job.ConfigSnapshot)
	if err != nil {
		return fmt.Errorf("failed to parse config snapshot: %w", err)
	}
	if provider == "" {
		provider = vc.Provider
	}
	if provider == "" {
		provider = "aws"
	}
	if identity != nil {
		vc.CloudAccountID = resolveAccountID(identity)
	}

	// E0 boundary: BYO IaC drift executes untrusted customer tofu (a refresh-only plan
	// still runs provider plugins). Refuse on a managed runner without the egress-enforced
	// container sandbox. Fail-closed, before any work.
	if err := w.byoManagedGate(vc, "DETECT_DRIFT"); err != nil {
		return err
	}

	_ = w.api.UpdateJobStatus(job.ID, "PROCESSING", "", map[string]any{
		"phase": "drift_refresh", "progress": "Running refresh-only plan...",
	})

	stateBackend, err := w.stateBackend(job.ID)
	if err != nil {
		return err
	}

	// BYO IaC drift runs the customer's own untrusted module → route it through the sandbox
	// seam (like deploy/plan/destroy), so a managed runner with the container backend active
	// (which the gate above guarantees) executes it INSIDE the container, not in-process.
	// InspectCluster is skipped: a customer's arbitrary module has no Alethia-managed
	// ArgoCD/add-on surface to inspect, and its (sensitive) tofu outputs stay in the sandbox.
	if vc.IacSource != nil {
		gitToken := vc.GitAccessToken
		if gitToken == "" {
			if fetched, ferr := w.api.FetchGitToken(job.ID, ""); ferr != nil {
				fmt.Fprintf(stderr, "Warning: failed to fetch git token: %v\n", ferr)
			} else {
				gitToken = fetched
			}
		}
		workDir, werr := newJobWorkDir(job.ID)
		if werr != nil {
			return fmt.Errorf("create workdir: %w", werr)
		}
		defer os.RemoveAll(workDir)

		payload := buildDriftPayload(vc, provider, "", "", w.config.AlethiaURL, job.ID)
		stage, serr := newStage(sandbox.StageDrift, payload)
		if serr != nil {
			return serr
		}
		sec := stageSecrets{GitToken: gitToken, StateToken: stateBackend.Token}
		if rerr := w.sandbox.Run(ctx, sandbox.Spec{
			Kind: "drift", JobID: job.ID, Provider: provider, WorkDir: workDir, Stage: stage,
			Stdout: stdout, Stderr: stderr,
			Warn: func(s string) { fmt.Fprintln(stdout, "[sandbox] "+s) },
		}, func(ctx context.Context) error {
			return runDriftStage(ctx, payload, sec, workDir, stdout, stderr)
		}); rerr != nil {
			return rerr
		}

		posture, prerr := readDriftPosture(workDir)
		if prerr != nil {
			fmt.Fprintf(stderr, "Warning: could not read drift result: %v\n", prerr)
		}
		if posture != nil {
			_ = w.api.UpdateJobStatus(job.ID, "PROCESSING", "", map[string]any{"drift_posture": posture})
		}
		return nil
	}

	posture, outputs, err := provisioner.RunDriftDetection(ctx, provisioner.DriftParams{
		ProjectConfig: vc,
		Provider:      provider,
		TemplatesDir:  filepath.Join(resolveProjectTemplatesDir(), provider),
		CategoriesDir: resolveCategoriesTemplatesDir(),
		StateBackend:  stateBackend,
		Stdout:        stdout,
		Stderr:        stderr,
	})
	if err != nil {
		return err
	}

	// Day-2 continuous refresh (best-effort): while we have the cluster's creds, read the
	// live ArgoCD add-on health + Trivy security posture so the console's Add-ons page and
	// Evidence Security tab stay current between deploys. Posted alongside drift_posture in one
	// update so it rides the same persistence path (the status route reads all three on SUCCESS).
	// The drift run's workspace outputs feed kubeconfig acquisition (alibaba/hetzner read the
	// sensitive `kubeconfig` output) and stay strictly in-process — never posted to the console.
	metadata := map[string]any{"drift_posture": posture}
	addonStatus, security := provisioner.InspectCluster(ctx, vc, provider, outputs, stdout, stderr)
	if len(addonStatus) > 0 {
		metadata["addon_status"] = addonStatus
	}
	if security != nil {
		metadata["security_report"] = security
	}

	_ = w.api.UpdateJobStatus(job.ID, "PROCESSING", "", metadata)
	return nil
}
