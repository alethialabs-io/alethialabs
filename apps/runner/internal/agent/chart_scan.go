// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/git"
	"github.com/alethialabs-io/alethialabs/packages/core/k8s"
	"github.com/alethialabs-io/alethialabs/packages/core/sandbox"
	"github.com/alethialabs-io/alethialabs/packages/core/utils"
	"github.com/alethialabs-io/alethialabs/packages/core/verify"
	"gopkg.in/yaml.v3"
)

// executeChartScan runs a SAFETY scan over a bring-your-own Helm chart. The PARENT (this
// function, trusted) clones the chart repo with the git token into the per-job workdir;
// the untrusted `helm template` render + verify then run through the sandbox seam with
// **deny-all egress and zero secrets** (the container child only reads the local chart).
// The resulting verify.Report is posted to execution_metadata.verify_result. Read-only —
// it provisions nothing.
func (w *Runner) executeChartScan(ctx context.Context, job *Job, stdout, stderr *JobLogger) error {
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

	workDir, err := newJobWorkDir(job.ID)
	if err != nil {
		return fmt.Errorf("create workdir: %w", err)
	}
	defer os.RemoveAll(workDir)

	// Parent clone (trusted: has the git token + egress). The chart lands under the
	// RW-mounted workdir so the untrusted render sees it without any token/egress.
	token, err := w.api.FetchGitToken(job.ID, "")
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

	// Resolve the chart dir INSIDE the clone (Clean on a rooted path strips `..` traversal).
	chartDir := filepath.Join(cloneDir, filepath.Clean("/"+chartPath))

	payload := stageChartScanPayload{ChartDir: chartDir, Values: values, JobID: job.ID}
	stage, err := newStage(sandbox.StageChartScan, payload)
	if err != nil {
		return err
	}

	// deny-all egress: the render needs no network (local chart). Untrusted Helm
	// templating (Sprig, lookup, .Files) is contained in the sandbox.
	if err := w.sandbox.Run(ctx, sandbox.Spec{
		Kind: "chart_scan", JobID: job.ID, WorkDir: workDir, Stage: stage,
		NoEgress: true, Stdout: stdout, Stderr: stderr,
		Warn: func(s string) { fmt.Fprintln(stdout, "[sandbox] "+s) },
	}, func(ctx context.Context) error {
		return runChartScanStage(ctx, payload, workDir, stdout, stderr)
	}); err != nil {
		return err
	}

	report, err := readVerifyReport(workDir)
	if err != nil {
		return fmt.Errorf("read scan result: %w", err)
	}
	// Post the safety verdict and the W5 DESCRIBE output together, so the console's finalize sees
	// both in one execution_metadata update. Missing describe output (older render, no workloads) is
	// benign — the console only persists chart_workloads when the describe flag is on.
	meta := map[string]any{}
	if report != nil {
		meta["verify_result"] = report
	}
	if workloads, werr := readChartWorkloads(workDir); werr != nil {
		fmt.Fprintf(stderr, "Read described workloads failed (non-fatal): %v\n", werr)
	} else if len(workloads) > 0 {
		meta["chart_workloads"] = workloads
	}
	if len(meta) > 0 {
		_ = w.api.UpdateJobStatus(job.ID, "PROCESSING", "", meta)
	}
	return nil
}

// runChartScanStage renders the local chart with `helm template` (no install) and runs
// the elench verify engine over the manifests, writing the verify.Report to result.json.
// Shared by the Passthrough closure and the container child — no git token, no egress.
func runChartScanStage(ctx context.Context, p stageChartScanPayload, workDir string, stdout, stderr io.Writer) error {
	_ = ctx

	helmCmd := fmt.Sprintf("helm template scan %s", shellQuote(p.ChartDir))
	if len(p.Values) > 0 {
		valuesFile := filepath.Join(workDir, "scan-values.yaml")
		data, merr := yaml.Marshal(p.Values)
		if merr != nil {
			return writeStageResult(workDir, stageResult{}, fmt.Errorf("marshal values: %w", merr))
		}
		if werr := os.WriteFile(valuesFile, data, 0o644); werr != nil {
			return writeStageResult(workDir, stageResult{}, fmt.Errorf("write values: %w", werr))
		}
		helmCmd += " --values " + shellQuote(valuesFile)
	}

	fmt.Fprintln(stdout, "Rendering chart (helm template — no install)…")
	manifests, err := utils.ExecuteCommandWithOutput(helmCmd, workDir, nil)
	if err != nil {
		return writeStageResult(workDir, stageResult{}, fmt.Errorf("helm template failed: %w", err))
	}

	report, err := verify.EvaluateManifests([]byte(manifests))
	if err != nil {
		return writeStageResult(workDir, stageResult{}, fmt.Errorf("evaluate manifests: %w", err))
	}
	fmt.Fprintf(stdout, "Scan verdict: %s (%d pass, %d fail, %d warn, %d not-evaluable)\n",
		report.Verdict, report.Summary.Pass, report.Summary.Fail, report.Summary.Warn,
		report.Summary.NotEvaluable)

	res := stageResult{}
	rb, _ := json.Marshal(report)
	res.VerifyReport = rb

	// W5 Path A DESCRIBE: extract the chart's workloads from the SAME rendered manifests the verify
	// report ran over (the render already succeeded, so a decode error here would be surprising —
	// it's non-fatal to the scan, which is fundamentally the safety verdict). Pure parsing, no
	// secrets: env is reduced to key NAMES inside k8s.Workloads.
	if resources, derr := k8s.Decode([]byte(manifests)); derr == nil {
		if workloads := k8s.Workloads(resources); len(workloads) > 0 {
			if wb, werr := json.Marshal(workloads); werr == nil {
				res.ChartWorkloads = wb
			}
			fmt.Fprintf(stdout, "Described %d workload(s) from the chart.\n", len(workloads))
		}
	} else {
		fmt.Fprintf(stderr, "Workload describe skipped (decode: %v)\n", derr)
	}

	return writeStageResult(workDir, res, nil)
}

// shellQuote single-quotes a path for a `bash -c` command line (utils.ExecuteCommand* uses bash),
// escaping any embedded single quotes so a chart path can't break out of the command.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
