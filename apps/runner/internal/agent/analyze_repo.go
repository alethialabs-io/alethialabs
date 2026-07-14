// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"github.com/alethialabs-io/alethialabs/packages/core/git"
	"github.com/alethialabs-io/alethialabs/packages/core/scanner"
)

// executeAnalyzeRepo clones the target repo and produces a STATIC RepoDigest (no
// repo code is executed — clone + walk + parse only) which the console feeds to the
// model to infer a Project. The digest is written to execution_metadata.repo_digest.
func (w *Runner) executeAnalyzeRepo(ctx context.Context, job *Job, stdout, stderr *JobLogger) error {
	_ = ctx
	repoURL, _ := job.ConfigSnapshot["repo_url"].(string)
	if repoURL == "" {
		return fmt.Errorf("config_snapshot missing repo_url")
	}
	ref, _ := job.ConfigSnapshot["ref"].(string)

	fmt.Fprintf(stdout, "Analyzing repository %s\n", repoURL)

	token, err := w.api.FetchGitToken(job.ID, "")
	if err != nil {
		fmt.Fprintf(stderr, "No git token (%v); attempting public clone.\n", err)
	}

	dir, err := os.MkdirTemp("", "alethia-scan-")
	if err != nil {
		return fmt.Errorf("create temp dir: %w", err)
	}
	defer os.RemoveAll(dir)

	var repo *git.GIT
	if token != "" {
		repo = git.NewGITWithToken(repoURL, dir, false, token)
	} else {
		repo = git.NewGIT(repoURL, dir, false)
	}

	fmt.Fprintln(stdout, "Cloning…")
	if err := repo.Clone(ref, true); err != nil {
		return fmt.Errorf("clone failed: %w", err)
	}

	fmt.Fprintln(stdout, "Scanning files (static analysis; no code executed)…")
	digest, err := scanner.Scan(dir, repoURL, ref, func(m string) { fmt.Fprintln(stdout, m) })
	if err != nil {
		return fmt.Errorf("scan failed: %w", err)
	}

	// JSON round-trip → map[string]any for execution_metadata.
	b, err := json.Marshal(digest)
	if err != nil {
		return fmt.Errorf("marshal digest: %w", err)
	}
	var digestMap map[string]any
	if err := json.Unmarshal(b, &digestMap); err != nil {
		return fmt.Errorf("decode digest: %w", err)
	}
	if err := w.api.UpdateJobStatus(job.ID, "PROCESSING", "", map[string]any{
		"repo_digest": digestMap,
	}); err != nil {
		return fmt.Errorf("persist digest: %w", err)
	}

	fmt.Fprintln(stdout, "Repository analysis complete.")
	return nil
}
