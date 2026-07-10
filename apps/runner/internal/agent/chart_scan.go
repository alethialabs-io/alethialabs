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
	"github.com/alethialabs-io/alethialabs/packages/core/utils"
	"github.com/alethialabs-io/alethialabs/packages/core/verify"
	"gopkg.in/yaml.v3"
)

// executeChartScan runs a SAFETY scan over a bring-your-own Helm chart: it clones the chart repo,
// renders it with `helm template` (no install — nothing is applied to any cluster), and runs the
// elench verify engine (verify.EvaluateManifests) over the rendered manifests. The resulting
// verify.Report — the same shape a PLAN/AUDIT gate produces — is posted to
// execution_metadata.verify_result, which the console persists onto the project_addons row and
// surfaces in the chart-scan sheet. Read-only + side-effect-free: it provisions nothing.
func (w *Runner) executeChartScan(ctx context.Context, job *Job, stdout, stderr *JobLogger) error {
	_ = ctx
	repoURL, _ := job.ConfigSnapshot["repo_url"].(string)
	if repoURL == "" {
		return fmt.Errorf("config_snapshot missing repo_url")
	}
	chartPath, _ := job.ConfigSnapshot["chart_path"].(string)
	if chartPath == "" {
		return fmt.Errorf("config_snapshot missing chart_path")
	}
	ref, _ := job.ConfigSnapshot["ref"].(string)
	values, _ := job.ConfigSnapshot["values"].(map[string]any)

	fmt.Fprintf(stdout, "Scanning Helm chart %s (%s @ %s)\n", chartPath, repoURL, ref)

	token, err := w.api.FetchGitToken(job.ID)
	if err != nil {
		fmt.Fprintf(stderr, "No git token (%v); attempting public clone.\n", err)
	}

	dir, err := os.MkdirTemp("", "alethia-chart-scan-")
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

	// Resolve the chart dir INSIDE the clone (Clean on a rooted path strips any `..` traversal).
	chartDir := filepath.Join(dir, filepath.Clean("/"+chartPath))

	helmCmd := fmt.Sprintf("helm template scan %s", shellQuote(chartDir))
	if len(values) > 0 {
		valuesFile := filepath.Join(dir, "scan-values.yaml")
		data, merr := yaml.Marshal(values)
		if merr != nil {
			return fmt.Errorf("marshal values: %w", merr)
		}
		if werr := os.WriteFile(valuesFile, data, 0o644); werr != nil {
			return fmt.Errorf("write values: %w", werr)
		}
		helmCmd += " --values " + shellQuote(valuesFile)
	}

	fmt.Fprintln(stdout, "Rendering chart (helm template — no install)…")
	manifests, err := utils.ExecuteCommandWithOutput(helmCmd, dir, nil)
	if err != nil {
		return fmt.Errorf("helm template failed: %w", err)
	}

	report, err := verify.EvaluateManifests([]byte(manifests))
	if err != nil {
		return fmt.Errorf("evaluate manifests: %w", err)
	}
	fmt.Fprintf(stdout, "Scan verdict: %s (%d pass, %d fail, %d warn, %d not-evaluable)\n",
		report.Verdict, report.Summary.Pass, report.Summary.Fail, report.Summary.Warn,
		report.Summary.NotEvaluable)

	_ = w.api.UpdateJobStatus(job.ID, "PROCESSING", "", map[string]any{"verify_result": report})
	return nil
}

// shellQuote single-quotes a path for a `bash -c` command line (utils.ExecuteCommand* uses bash),
// escaping any embedded single quotes so a chart path can't break out of the command.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
