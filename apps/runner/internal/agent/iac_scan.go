// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/git"
	"github.com/alethialabs-io/alethialabs/packages/core/sandbox"
)

// executeIacScan runs a SAFETY scan over a bring-your-own IaC root module. The PARENT
// (this function, trusted) clones the customer's repo with the git token into the per-job
// workdir and pins the exact commit it checked out; the untrusted static gate +
// `tofu init -backend=false` + `tofu validate` then run through the sandbox seam carrying
// ZERO secrets (no git token, no cloud creds, no state token — the scan produces NO tofu
// plan). The resulting IacScanReport (with the pinned commit_sha) is posted to
// execution_metadata.iac_scan_result, which console finalizeIacScan reads back onto the
// project_iac_sources row. Read-only — it provisions nothing.
//
// Unlike chart_scan the stage is NOT deny-all egress: `tofu init` fetches provider plugins.
// On a managed runner with the container backend this is contained by the egress-enforced
// net (the container backend's own gate); on the default Passthrough it runs in-process
// exactly like chart_scan (loud warning; refuses under ALETHIA_SANDBOX_ENFORCE_MANAGED).
func (w *Runner) executeIacScan(ctx context.Context, job *Job, stdout, stderr *JobLogger) error {
	repoURL, _ := job.ConfigSnapshot["repo_url"].(string)
	if repoURL == "" {
		return fmt.Errorf("config_snapshot missing repo_url")
	}
	ref := getSnapshotString(job.ConfigSnapshot, "ref")
	modulePath := getSnapshotString(job.ConfigSnapshot, "path")

	fmt.Fprintf(stdout, "Scanning BYO IaC module %q (%s @ %s)\n", modulePath, repoURL, ref)

	workDir, err := newJobWorkDir(job.ID)
	if err != nil {
		return fmt.Errorf("create workdir: %w", err)
	}
	defer os.RemoveAll(workDir)

	// Parent clone (trusted: holds the git token + egress). The module lands under the
	// RW-mounted workdir so the untrusted scan reads it without any token/egress secret.
	token, err := w.api.FetchGitToken(job.ID)
	if err != nil {
		fmt.Fprintf(stderr, "No git token (%v); attempting public clone.\n", err)
	}
	cloneDir := filepath.Join(workDir, "clone")
	var repo *git.GIT
	if token != "" {
		repo = git.NewGITWithToken(repoURL, cloneDir, false, token)
	} else {
		repo = git.NewGIT(repoURL, cloneDir, false)
	}
	fmt.Fprintln(stdout, "Cloning…")
	if err := repo.Clone(ref, true); err != nil {
		return fmt.Errorf("clone failed: %w", err)
	}

	// Pin the exact commit the scan runs over so the deploy applies these bytes (TOCTOU).
	commitSHA, err := repo.HeadSHA()
	if err != nil {
		return fmt.Errorf("resolve HEAD commit: %w", err)
	}
	fmt.Fprintf(stdout, "Pinned scan commit %s\n", commitSHA)

	// Resolve the module dir INSIDE the clone (traversal-guarded: lexical clean + symlink
	// containment), mirroring the provisioner's resolveByoModuleDir.
	moduleDir, err := resolveModuleDirInClone(cloneDir, modulePath)
	if err != nil {
		return err
	}

	payload := stageIacScanPayload{
		ModuleDir:  moduleDir,
		CommitSHA:  commitSHA,
		IacVersion: getSnapshotString(job.ConfigSnapshot, "iac_version"),
		JobID:      job.ID,
	}
	stage, err := newStage(sandbox.StageIacScan, payload)
	if err != nil {
		return err
	}

	// NOT NoEgress: `tofu init` needs to fetch provider plugins. Zero secrets cross into
	// the child (no git/state token, no cloud creds).
	if err := w.sandbox.Run(ctx, sandbox.Spec{
		Kind: "iac_scan", JobID: job.ID, WorkDir: workDir, Stage: stage,
		Stdout: stdout, Stderr: stderr,
		Warn: func(s string) { fmt.Fprintln(stdout, "[sandbox] "+s) },
	}, func(ctx context.Context) error {
		return runIacScanStage(ctx, payload, workDir, stdout, stderr)
	}); err != nil {
		return err
	}

	report, err := readIacScanReport(workDir)
	if err != nil {
		return fmt.Errorf("read scan result: %w", err)
	}
	if report != nil {
		fmt.Fprintf(stdout, "IaC scan verdict: ok=%v validated=%v (%d finding(s), %d provider(s))\n",
			report.OK, report.Validated, len(report.Findings), len(report.Providers))
		// Post as execution_metadata.iac_scan_result (mirrors how chart_scan posts
		// verify_result). The SCAN job itself SUCCEEDS even when ok=false — the scan RAN;
		// its report carries the verdict, and console finalizeIacScan only pins the commit
		// when the job SUCCEEDED with an ok report.
		_ = w.api.UpdateJobStatus(job.ID, "PROCESSING", "", map[string]any{"iac_scan_result": report})
	}
	return nil
}

// resolveModuleDirInClone resolves a customer module path inside the clone and verifies it
// stays within the clone (no `..` or symlink escape), returning the absolute, symlink-
// resolved module directory. Mirrors provisioner.resolveByoModuleDir (kept local so the
// untrusted scan enforces the same containment boundary).
func resolveModuleDirInClone(cloneDir, path string) (string, error) {
	cloneAbs, err := filepath.Abs(cloneDir)
	if err != nil {
		return "", fmt.Errorf("resolving clone dir: %w", err)
	}
	// filepath.Clean("/"+path) collapses any leading `..` against a virtual root, so a
	// "../../etc" path becomes "/etc" then joins under the clone — it can never climb above
	// the clone lexically.
	rel := filepath.Clean("/" + strings.TrimSpace(path))
	moduleDir := filepath.Join(cloneAbs, rel)

	relToClone, err := filepath.Rel(cloneAbs, moduleDir)
	if err != nil || relToClone == ".." || strings.HasPrefix(relToClone, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("BYO IaC path %q resolves outside the repository clone", path)
	}

	// Symlink-resolved containment: os.Stat follows symlinks, so a repo-committed symlink
	// escaping the clone must be rejected.
	realClone, err := filepath.EvalSymlinks(cloneAbs)
	if err != nil {
		return "", fmt.Errorf("resolving clone dir symlinks: %w", err)
	}
	realModule, err := filepath.EvalSymlinks(moduleDir)
	if err != nil {
		return "", fmt.Errorf("BYO IaC module path %q not found in repository: %w", path, err)
	}
	relReal, err := filepath.Rel(realClone, realModule)
	if err != nil || relReal == ".." || strings.HasPrefix(relReal, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("BYO IaC path %q resolves outside the repository clone (via symlink)", path)
	}
	info, err := os.Stat(realModule)
	if err != nil || !info.IsDir() {
		return "", fmt.Errorf("BYO IaC module path %q is not a directory", path)
	}
	return realModule, nil
}
