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

	"github.com/alethialabs-io/alethialabs/packages/core/categories"
	"github.com/alethialabs-io/alethialabs/packages/core/git"
	"github.com/alethialabs-io/alethialabs/packages/core/helmoci"
	"github.com/alethialabs-io/alethialabs/packages/core/k8s"
	"github.com/alethialabs-io/alethialabs/packages/core/sandbox"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/alethialabs-io/alethialabs/packages/core/utils"
	"github.com/alethialabs-io/alethialabs/packages/core/verify"
	"gopkg.in/yaml.v3"
)

// executeChartScan runs a SAFETY scan over a bring-your-own Helm chart. The PARENT (this
// function, trusted) resolves the chart into a local directory inside the per-job workdir — a git
// clone using the git token, or an OCI registry pull using the project's helm_registry credential.
// The untrusted `helm template` render + verify then run through the sandbox seam with **deny-all
// egress and zero secrets** (the container child only reads the local chart). The resulting
// verify.Report is posted to execution_metadata.verify_result. Read-only — it provisions nothing.
//
// Both fetch strategies deliberately stay in the parent. That is what keeps the render stage
// NoEgress and secret-free no matter where the chart came from, so the trust boundary is identical
// for a git chart and an OCI one.
func (w *Runner) executeChartScan(ctx context.Context, job *Job, connectorCreds []ConnectorCredential, stdout, stderr *JobLogger) error {
	repoURL, _ := job.ConfigSnapshot["repo_url"].(string)
	if repoURL == "" {
		return fmt.Errorf("config_snapshot missing repo_url")
	}
	ref, _ := job.ConfigSnapshot["ref"].(string)
	values, _ := job.ConfigSnapshot["values"].(map[string]any)

	workDir, err := newJobWorkDir(job.ID)
	if err != nil {
		return fmt.Errorf("create workdir: %w", err)
	}
	defer os.RemoveAll(workDir)

	var chartDir string
	if isOCIChartRepo(repoURL) {
		chartDir, err = w.fetchOCIChart(ctx, job, repoURL, ref, connectorCreds, workDir, stdout, stderr)
	} else {
		chartDir, err = w.fetchGitChart(ctx, job, repoURL, ref, workDir, stdout, stderr)
	}
	if err != nil {
		return err
	}

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

// isOCIChartRepo reports whether a chart_repo value addresses an OCI registry rather than a git
// repository. The console stores the two in the same column, so the scheme is what routes them.
func isOCIChartRepo(repoURL string) bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(repoURL)), "oci://")
}

// fetchGitChart is the original chart source: clone the repo with the job's git token and point at
// a chart directory inside it. Unchanged behaviour — chart_path is still required, because a git
// repo has no other way to say which directory holds the chart.
func (w *Runner) fetchGitChart(ctx context.Context, job *Job, repoURL, ref, workDir string, stdout, stderr *JobLogger) (string, error) {
	chartPath, _ := job.ConfigSnapshot["chart_path"].(string)
	if chartPath == "" {
		return "", fmt.Errorf("config_snapshot missing chart_path")
	}
	fmt.Fprintf(stdout, "Scanning Helm chart %s (%s @ %s)\n", chartPath, repoURL, ref)

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
	if err := repo.Clone(ctx, ref, true); err != nil {
		return "", fmt.Errorf("clone failed: %w", err)
	}

	// Resolve the chart dir INSIDE the clone (Clean on a rooted path strips `..` traversal).
	return filepath.Join(cloneDir, filepath.Clean("/"+chartPath)), nil
}

// fetchOCIChart pulls a chart from an OCI registry into the workdir. The chart-repo credential is
// resolved from the project's connected helm_registry connectors using the SAME longest-URL-prefix
// rule ArgoCD applies at deploy time, so the scan authenticates against exactly the repo the deploy
// will — and never against a host the project never connected.
//
// A chart whose host no connected connector covers is pulled ANONYMOUSLY rather than refused: a
// public chart must still be scannable without the customer connecting anything.
func (w *Runner) fetchOCIChart(
	ctx context.Context,
	job *Job,
	repoURL, version string,
	connectorCreds []ConnectorCredential,
	workDir string,
	stdout, stderr *JobLogger,
) (string, error) {
	chartRef, err := helmoci.ParseChartRef(repoURL, ociChartVersion(version))
	if err != nil {
		return "", err
	}
	fmt.Fprintf(stdout, "Scanning Helm chart %s (version %s)\n", chartRef, chartRef.Version)

	vc := types.ProjectConfig{
		HelmRegistries:       helmRegistriesFromSnapshot(job.ConfigSnapshot, stderr),
		ConnectorCredentials: toCoreConnectorCreds(connectorCreds),
	}
	cred, matched, credErr := categories.RepoCredForChartRepo(&vc, chartRef.String())
	if credErr != nil {
		// A misconfigured chart repo must not sink the scan — log it and carry on, mirroring how
		// the deploy path treats a bad repo credential.
		fmt.Fprintf(stderr, "Chart repo credential skipped: %v\n", credErr)
	}

	var creds helmoci.Creds
	if matched {
		creds = helmoci.Creds{Username: cred.Username, Password: cred.Password}
		// Log the repo URL only — never the username or password.
		fmt.Fprintf(stdout, "Authenticating with the chart repo connected for %s\n", cred.URL)
	} else {
		fmt.Fprintf(stdout, "No chart-repo connector covers %s; pulling anonymously.\n", chartRef.Registry)
	}

	fmt.Fprintln(stdout, "Pulling chart…")
	res, err := helmoci.Pull(ctx, chartRef, creds, workDir)
	if err != nil {
		return "", fmt.Errorf("chart pull failed: %w", err)
	}
	fmt.Fprintf(stdout, "Pulled chart version %s (%s)\n", res.Version, res.Digest)
	return res.ChartDir, nil
}

// ociChartVersion maps the snapshot's `ref` field onto a chart version. The field is shared with
// the git path, whose default is the git-only sentinel "HEAD"; for an OCI chart that means "no
// version was pinned", which is Helm's `*`.
func ociChartVersion(ref string) string {
	v := strings.TrimSpace(ref)
	if v == "" || strings.EqualFold(v, "HEAD") {
		return helmoci.LatestVersion
	}
	return v
}

// helmRegistriesFromSnapshot reads the project's connected chart repos off the CHART_SCAN snapshot.
// They carry the non-secret provider config (registry host, repo URL) the credential match needs;
// the secret half arrives separately on the job claim and never touches the snapshot.
//
// A malformed entry is non-fatal: the scan then finds no covering credential and falls back to an
// anonymous pull, which fails loudly at the registry rather than silently scanning the wrong thing.
func helmRegistriesFromSnapshot(snapshot map[string]any, stderr io.Writer) []types.ProjectHelmRegistryConfig {
	raw, ok := snapshot["helm_registries"]
	if !ok || raw == nil {
		return nil
	}
	encoded, err := json.Marshal(raw)
	if err != nil {
		fmt.Fprintf(stderr, "Ignoring helm_registries in the snapshot (%v)\n", err)
		return nil
	}
	var out []types.ProjectHelmRegistryConfig
	if err := json.Unmarshal(encoded, &out); err != nil {
		fmt.Fprintf(stderr, "Ignoring helm_registries in the snapshot (%v)\n", err)
		return nil
	}
	return out
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
		// Helm values can carry secrets — owner-only even inside the sandbox workdir.
		if werr := utils.WriteSecretFile(valuesFile, data); werr != nil {
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
