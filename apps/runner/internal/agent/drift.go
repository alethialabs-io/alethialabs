// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"fmt"
	"path/filepath"

	"github.com/alethialabs-io/alethialabs/packages/core/provisioner"
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

	_ = w.api.UpdateJobStatus(job.ID, "PROCESSING", "", map[string]any{
		"phase": "drift_refresh", "progress": "Running refresh-only plan...",
	})

	posture, err := provisioner.RunDriftDetection(ctx, provisioner.DriftParams{
		ProjectConfig: vc,
		Provider:      provider,
		TemplatesDir:  filepath.Join(resolveProjectTemplatesDir(), provider),
		CategoriesDir: resolveCategoriesTemplatesDir(),
		S3Backend:     w.s3Backend(),
		Stdout:        stdout,
		Stderr:        stderr,
	})
	if err != nil {
		return err
	}

	_ = w.api.UpdateJobStatus(job.ID, "PROCESSING", "", map[string]any{"drift_posture": posture})
	return nil
}
