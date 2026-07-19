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
	"strconv"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	"github.com/alethialabs-io/alethialabs/packages/core/drift"
	"github.com/alethialabs-io/alethialabs/packages/core/iacsafety"
	"github.com/alethialabs-io/alethialabs/packages/core/provisioner"
	"github.com/alethialabs-io/alethialabs/packages/core/sandbox"
	"github.com/alethialabs-io/alethialabs/packages/core/tofu"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/alethialabs-io/alethialabs/packages/core/verify"
)

// This file is the single source of truth for the serialized untrusted work. The
// stage* payloads describe a job's work WITHOUT secrets (git/state tokens cross via the
// child's allowlisted env, not the workdir payload); the run*Stage functions reconstruct
// the provisioner params and run the work, writing result.json into the workdir. BOTH
// the in-process Passthrough closure (parent) and the re-exec'd container child call the
// SAME run*Stage function, so the two backends can never diverge.

// stageDeployPayload reconstructs provisioner.DeployParams for a deploy (DryRun=false)
// or plan (DryRun=true). ProjectConfig's json:"-" fields (CloudAccountID,
// ConnectorCredentials) are dropped by JSON, so they are carried explicitly and
// reattached in runDeployStage.
type stageDeployPayload struct {
	ProjectConfig        *types.ProjectConfig        `json:"project_config"`
	CloudAccountID       string                      `json:"cloud_account_id"`
	ConnectorCredentials []types.ConnectorCredential `json:"connector_credentials"`
	Provider             string                      `json:"provider"`
	DryRun               bool                        `json:"dry_run"`
	PlanFile             string                      `json:"plan_file,omitempty"`
	TemplatesDir         string                      `json:"templates_dir"`
	CategoriesDir        string                      `json:"categories_dir"`
	InfracostToken       string                      `json:"infracost_token,omitempty"`
	VerifyOverride       *verify.Override            `json:"verify_override,omitempty"`
	// CostCeilingMonthlyUSD fail-closes a real apply whose Infracost estimate exceeds it
	// (0 ⇒ disabled). Read from ALETHIA_COST_CEILING_MONTHLY_USD in the parent and carried
	// in the payload so it survives the sandbox boundary (the container child sees no env).
	CostCeilingMonthlyUSD float64 `json:"cost_ceiling_monthly_usd,omitempty"`
	StateConsoleURL       string  `json:"state_console_url"`
	JobID                 string  `json:"job_id"`
}

// stageDestroyPayload reconstructs provisioner.DestroyParams.
type stageDestroyPayload struct {
	ProjectConfig        *types.ProjectConfig        `json:"project_config"`
	CloudAccountID       string                      `json:"cloud_account_id"`
	ConnectorCredentials []types.ConnectorCredential `json:"connector_credentials"`
	Provider             string                      `json:"provider"`
	TemplatesDir         string                      `json:"templates_dir"`
	CategoriesDir        string                      `json:"categories_dir"`
	StateConsoleURL      string                      `json:"state_console_url"`
	JobID                string                      `json:"job_id"`
}

// stageChartScanPayload reconstructs a chart-safety scan. The chart is already cloned by
// the PARENT into the workdir (which needs the git token + egress); the stage only runs
// `helm template` + verify on the local chart dir — zero secrets, deny-all egress.
type stageChartScanPayload struct {
	ChartDir string         `json:"chart_dir"` // absolute path inside the (mounted) workdir
	Values   map[string]any `json:"values,omitempty"`
	JobID    string         `json:"job_id"`
}

// stageIacScanPayload reconstructs a bring-your-own IaC safety scan. The module is
// already cloned + pinned by the PARENT into the workdir (which needs the git token +
// egress); the stage runs the parse-only iacsafety gate + `tofu init -backend=false` +
// `tofu validate` on the local module dir. It carries ZERO secrets (no git token, no
// state token, no cloud creds) but DOES need egress (tofu init fetches provider plugins).
type stageIacScanPayload struct {
	ModuleDir  string `json:"module_dir"` // absolute path inside the (mounted) workdir
	CommitSHA  string `json:"commit_sha"` // the pinned commit the scan runs over
	IacVersion string `json:"iac_version,omitempty"`
	JobID      string `json:"job_id"`
}

// stageDriftPayload reconstructs a refresh-only drift run for a BYO IaC module. Like
// deploy/plan/destroy the untrusted customer tofu runs through the sandbox seam; the
// git/state tokens cross via the child's allowlisted env (stageSecrets), not the payload.
type stageDriftPayload struct {
	ProjectConfig   *types.ProjectConfig `json:"project_config"`
	CloudAccountID  string               `json:"cloud_account_id"`
	Provider        string               `json:"provider"`
	TemplatesDir    string               `json:"templates_dir,omitempty"`
	CategoriesDir   string               `json:"categories_dir,omitempty"`
	StateConsoleURL string               `json:"state_console_url"`
	JobID           string               `json:"job_id"`
}

// stageSecrets are per-job secrets sourced by the caller: the parent fills them from its
// scope (Passthrough); the child fills them from its allowlisted env (container).
type stageSecrets struct {
	GitToken   string
	StateToken string
	// GitTokens maps a BYO chart repo URL → its git token, when the repo lives on a different
	// provider than the apps-destination repo (see runner.go's per-repo resolution). Crosses the
	// container boundary as a JSON-encoded ALETHIA_STAGE_GIT_TOKENS env var.
	GitTokens map[string]string
	// AddonSecrets maps add-on id → secret field key → plaintext (W4.5 #640), fetched by the
	// parent over the authenticated job channel (FetchAddonSecrets). Crosses the container
	// boundary as a JSON-encoded ALETHIA_STAGE_ADDON_SECRETS env var — never the payload,
	// which is persisted to stage.json in the workdir.
	AddonSecrets map[string]map[string]string
}

func stageSecretsFromEnv() stageSecrets {
	gitTokens := map[string]string{}
	if raw := os.Getenv("ALETHIA_STAGE_GIT_TOKENS"); raw != "" {
		_ = json.Unmarshal([]byte(raw), &gitTokens)
	}
	addonSecrets := map[string]map[string]string{}
	if raw := os.Getenv("ALETHIA_STAGE_ADDON_SECRETS"); raw != "" {
		_ = json.Unmarshal([]byte(raw), &addonSecrets)
	}
	return stageSecrets{
		GitToken:     os.Getenv("ALETHIA_STAGE_GIT_TOKEN"),
		StateToken:   os.Getenv("TF_HTTP_PASSWORD"),
		GitTokens:    gitTokens,
		AddonSecrets: addonSecrets,
	}
}

// stageResult is written to result.json by the run*Stage functions and read back by the
// parent (readPlanResult / readVerifyReport).
type stageResult struct {
	PlanResult   json.RawMessage `json:"plan_result,omitempty"`
	VerifyReport json.RawMessage `json:"verify_report,omitempty"`
	IacReport    json.RawMessage `json:"iac_report,omitempty"`
	DriftPosture json.RawMessage `json:"drift_posture,omitempty"`
	// ChartWorkloads is the W5 Path A DESCRIBE output of a chart scan — the []types.ChartWorkload
	// extracted from the same rendered manifests the verify report runs over. Carried beside the
	// verify report and posted to execution_metadata.chart_workloads.
	ChartWorkloads json.RawMessage `json:"chart_workloads,omitempty"`
	Error          string          `json:"error,omitempty"`
}

// newStage marshals a payload into a sandbox.Stage for the container backend.
func newStage(kind sandbox.StageKind, payload any) (*sandbox.Stage, error) {
	b, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("marshal %s stage: %w", kind, err)
	}
	return &sandbox.Stage{Kind: kind, Payload: b}, nil
}

// buildDeployPayload projects DeployParams inputs into a serializable payload, blanking
// the git token (it crosses via env) and carrying the json:"-" fields explicitly.
func buildDeployPayload(vc *types.ProjectConfig, provider string, dryRun bool, planFile,
	templatesDir, categoriesDir, infracostToken string, override *verify.Override,
	stateConsoleURL, jobID string) stageDeployPayload {
	cfg := *vc // shallow copy — don't mutate the caller's config
	cfg.GitAccessToken = ""
	return stageDeployPayload{
		ProjectConfig:         &cfg,
		CloudAccountID:        vc.CloudAccountID,
		ConnectorCredentials:  vc.ConnectorCredentials,
		Provider:              provider,
		DryRun:                dryRun,
		PlanFile:              planFile,
		TemplatesDir:          templatesDir,
		CategoriesDir:         categoriesDir,
		InfracostToken:        infracostToken,
		VerifyOverride:        override,
		CostCeilingMonthlyUSD: costCeilingFromEnv(),
		StateConsoleURL:       stateConsoleURL,
		JobID:                 jobID,
	}
}

// costCeilingFromEnv parses the opt-in real-apply cost ceiling (monthly USD) from
// ALETHIA_COST_CEILING_MONTHLY_USD. Unset, empty, unparseable, or non-positive ⇒ 0
// (guard disabled). Read in the parent so it can be carried across the sandbox boundary.
func costCeilingFromEnv() float64 {
	raw := strings.TrimSpace(os.Getenv("ALETHIA_COST_CEILING_MONTHLY_USD"))
	if raw == "" {
		return 0
	}
	v, err := strconv.ParseFloat(raw, 64)
	if err != nil || v <= 0 {
		return 0
	}
	return v
}

func buildDestroyPayload(vc *types.ProjectConfig, provider, templatesDir, categoriesDir,
	stateConsoleURL, jobID string) stageDestroyPayload {
	cfg := *vc
	cfg.GitAccessToken = ""
	return stageDestroyPayload{
		ProjectConfig:        &cfg,
		CloudAccountID:       vc.CloudAccountID,
		ConnectorCredentials: vc.ConnectorCredentials,
		Provider:             provider,
		TemplatesDir:         templatesDir,
		CategoriesDir:        categoriesDir,
		StateConsoleURL:      stateConsoleURL,
		JobID:                jobID,
	}
}

// runDeployStage reconstructs DeployParams and runs RunDeployV2, writing result.json into
// workDir. Shared by the Passthrough closure and the container child.
func runDeployStage(ctx context.Context, p stageDeployPayload, sec stageSecrets, workDir string, stdout, stderr io.Writer) error {
	vc := p.ProjectConfig
	vc.CloudAccountID = p.CloudAccountID
	vc.ConnectorCredentials = p.ConnectorCredentials
	vc.GitAccessToken = sec.GitToken

	result, err := provisioner.RunDeployV2(ctx, provisioner.DeployParams{
		ProjectConfig:         vc,
		Provider:              p.Provider,
		DryRun:                p.DryRun,
		PlanFile:              p.PlanFile,
		TemplatesDir:          p.TemplatesDir,
		CategoriesDir:         p.CategoriesDir,
		InfracostToken:        p.InfracostToken,
		CostCeilingMonthlyUSD: p.CostCeilingMonthlyUSD,
		GitAccessToken:        sec.GitToken,
		GitRepoTokens:         sec.GitTokens,
		StateBackend:          &cloud.HTTPBackendConfig{ConsoleURL: p.StateConsoleURL, JobID: p.JobID, Token: sec.StateToken},
		// Record the provisioning phase under the workdir so the runner can tell an
		// interrupted apply (orphan risk) from a pre-apply cancel. Shared by the
		// Passthrough (same process) and container child (RW-mounted workdir) paths.
		PhaseFile:      deployPhaseFile(workDir),
		Stdout:         stdout,
		Stderr:         stderr,
		VerifyOverride: p.VerifyOverride,
		// Add-on secret-knob values (W4.5 #640) — sourced from stageSecrets (parent scope
		// or the allowlisted child env), never from the persisted payload.
		AddOnSecretValues: sec.AddonSecrets,
	})
	res := stageResult{}
	if result != nil {
		res.PlanResult, _ = json.Marshal(result)
	}
	return writeStageResult(workDir, res, err)
}

// runDestroyStage reconstructs DestroyParams and runs RunDestroy.
func runDestroyStage(ctx context.Context, p stageDestroyPayload, sec stageSecrets, workDir string, stdout, stderr io.Writer) error {
	vc := p.ProjectConfig
	vc.CloudAccountID = p.CloudAccountID
	vc.ConnectorCredentials = p.ConnectorCredentials

	err := provisioner.RunDestroy(ctx, provisioner.DestroyParams{
		ProjectConfig: vc,
		Provider:      p.Provider,
		TemplatesDir:  p.TemplatesDir,
		CategoriesDir: p.CategoriesDir,
		StateBackend:  &cloud.HTTPBackendConfig{ConsoleURL: p.StateConsoleURL, JobID: p.JobID, Token: sec.StateToken},
		Stdout:        stdout,
		Stderr:        stderr,
	})
	return writeStageResult(workDir, stageResult{}, err)
}

// buildDriftPayload projects a BYO drift run into a serializable payload (the git/state
// tokens cross via the child env, not here).
func buildDriftPayload(vc *types.ProjectConfig, provider, templatesDir, categoriesDir,
	stateConsoleURL, jobID string) stageDriftPayload {
	cfg := *vc // shallow copy — don't mutate the caller's config
	cfg.GitAccessToken = ""
	return stageDriftPayload{
		ProjectConfig:   &cfg,
		CloudAccountID:  vc.CloudAccountID,
		Provider:        provider,
		TemplatesDir:    templatesDir,
		CategoriesDir:   categoriesDir,
		StateConsoleURL: stateConsoleURL,
		JobID:           jobID,
	}
}

// runIacScanStage runs the bring-your-own IaC safety scan over the (already cloned +
// pinned) local module dir and writes an IacScanReport to result.json. Shared by the
// Passthrough closure and the container child — it holds NO secrets. It runs the
// parse-only iacsafety gate first (never evaluates HCL); only if that gate passes does it
// run `tofu init -backend=false` + `tofu validate` (which executes provider plugins) — a
// module the static gate rejected (remote sources / provisioners / unallowlisted provider)
// is NEVER handed to `tofu init`.
func runIacScanStage(ctx context.Context, p stageIacScanPayload, workDir string, stdout, stderr io.Writer) error {
	fmt.Fprintf(stdout, "Running BYO IaC static gate over %s\n", p.ModuleDir)
	rep, err := iacsafety.Scan(p.ModuleDir, iacsafety.AllowlistFromEnv())
	if err != nil {
		// A scan-setup failure is a stage error (the report couldn't be produced).
		return writeStageResult(workDir, stageResult{}, fmt.Errorf("BYO IaC static scan failed: %w", err))
	}

	report := types.IacScanReport{
		OK:        rep.OK,
		Validated: false,
		Findings:  toIacFindings(rep.Findings),
		Providers: nonNilStrings(rep.Providers),
		Modules:   nonNilStrings(rep.Modules),
		Resources: toIacResources(rep.Resources),
		Outputs:   nonNilStrings(rep.Outputs),
		CommitSHA: p.CommitSHA,
	}
	fmt.Fprintf(stdout, "Static gate: ok=%v (providers=%v, %d module(s), %d resource(s), %d output(s), %d finding(s))\n",
		rep.OK, report.Providers, len(report.Modules), len(report.Resources), len(report.Outputs), len(report.Findings))

	// Only run tofu (which executes provider plugins) on a module the static gate cleared.
	if rep.OK {
		if verr := runIacTofuValidate(ctx, p, stdout, stderr); verr != nil {
			// `tofu validate` failing is a finding (bad config), not a stage error — the
			// scan still produced a report. It flips OK=false so provisioning stays blocked.
			report.Validated = false
			report.OK = false
			report.Findings = append(report.Findings, types.IacScanFinding{
				Severity: iacsafety.SeverityError,
				Rule:     "tofu-validate",
				File:     ".",
				Detail:   verr.Error(),
			})
			fmt.Fprintf(stderr, "tofu validate reported errors: %v\n", verr)
		} else {
			report.Validated = true
			fmt.Fprintln(stdout, "tofu validate: OK")
		}
	}

	rb, mErr := json.Marshal(report)
	if mErr != nil {
		return writeStageResult(workDir, stageResult{}, fmt.Errorf("marshal iac scan report: %w", mErr))
	}
	return writeStageResult(workDir, stageResult{IacReport: rb}, nil)
}

// runIacTofuValidate runs `tofu init -backend=false` + `tofu validate` in the module dir.
// It carries no state backend and no cloud creds — it only resolves provider schemas to
// validate the configuration. Returns an error describing the first validate failure.
func runIacTofuValidate(ctx context.Context, p stageIacScanPayload, stdout, stderr io.Writer) error {
	tf, err := tofu.NewTofuCLI(ctx, p.IacVersion, p.ModuleDir, stdout, stderr)
	if err != nil {
		return fmt.Errorf("tofu setup: %w", err)
	}
	if err := tf.InitNoBackend(ctx); err != nil {
		return fmt.Errorf("tofu init -backend=false: %w", err)
	}
	out, err := tf.Validate(ctx)
	if err != nil {
		return fmt.Errorf("tofu validate: %w", err)
	}
	if out != nil && !out.Valid {
		var b strings.Builder
		for _, d := range out.Diagnostics {
			if b.Len() > 0 {
				b.WriteString("; ")
			}
			fmt.Fprintf(&b, "%s: %s", d.Severity, d.Summary)
		}
		return fmt.Errorf("%s", b.String())
	}
	return nil
}

// runDriftStage runs a refresh-only BYO drift detection and writes the drift Posture to
// result.json. Shared by the Passthrough closure and the container child. It returns ONLY
// the posture — the sensitive tofu outputs stay inside the sandbox and are discarded (a
// customer's own module has no Alethia-managed ArgoCD/add-on surface to inspect).
func runDriftStage(ctx context.Context, p stageDriftPayload, sec stageSecrets, workDir string, stdout, stderr io.Writer) error {
	vc := p.ProjectConfig
	vc.CloudAccountID = p.CloudAccountID
	vc.GitAccessToken = sec.GitToken

	posture, _, err := provisioner.RunDriftDetection(ctx, provisioner.DriftParams{
		ProjectConfig:  vc,
		Provider:       p.Provider,
		TemplatesDir:   p.TemplatesDir,
		CategoriesDir:  p.CategoriesDir,
		StateBackend:   &cloud.HTTPBackendConfig{ConsoleURL: p.StateConsoleURL, JobID: p.JobID, Token: sec.StateToken},
		GitAccessToken: sec.GitToken,
		Stdout:         stdout,
		Stderr:         stderr,
	})
	res := stageResult{}
	if posture != nil {
		res.DriftPosture, _ = json.Marshal(posture)
	}
	return writeStageResult(workDir, res, err)
}

// toIacFindings converts iacsafety findings to the console-contract IacScanFinding shape.
// Always returns a non-nil slice so the report's `findings` serializes as [] not null.
func toIacFindings(in []iacsafety.Finding) []types.IacScanFinding {
	out := make([]types.IacScanFinding, 0, len(in))
	for _, f := range in {
		out = append(out, types.IacScanFinding{
			Severity: f.Severity,
			Rule:     f.Rule,
			File:     f.File,
			Line:     f.Line,
			Detail:   f.Detail,
		})
	}
	return out
}

// toIacResources converts the static gate's declared resource inventory to the
// console-contract IacResource shape, stamping each with its Terraform address (the key
// cost / drift / verify all join on). Always non-nil so `resources` serializes as [].
func toIacResources(in []iacsafety.Resource) []types.IacResource {
	out := make([]types.IacResource, 0, len(in))
	for _, r := range in {
		out = append(out, types.IacResource{
			Address: r.Address(),
			Type:    r.Type,
			Name:    r.Name,
			Module:  r.Module,
		})
	}
	return out
}

// nonNilStrings returns s, or an empty (non-nil) slice, so JSON serializes [] not null.
func nonNilStrings(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// writeStageResult writes result.json (with Error set on failure) and returns stageErr so
// both the closure and the child signal failure consistently.
func writeStageResult(workDir string, res stageResult, stageErr error) error {
	if stageErr != nil {
		res.Error = stageErr.Error()
	}
	b, _ := json.Marshal(res)
	if werr := os.WriteFile(filepath.Join(workDir, "result.json"), b, 0o600); werr != nil {
		if stageErr != nil {
			return stageErr
		}
		return fmt.Errorf("write result.json: %w", werr)
	}
	return stageErr
}

// readPlanResult decodes result.json's PlanResult (nil if absent). The parent calls it
// after the sandbox runs, regardless of backend.
func readPlanResult(workDir string) (*provisioner.PlanResult, error) {
	b, err := os.ReadFile(filepath.Join(workDir, "result.json"))
	if err != nil {
		return nil, err
	}
	var r stageResult
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, err
	}
	if len(r.PlanResult) == 0 {
		return nil, nil
	}
	var pr provisioner.PlanResult
	if err := json.Unmarshal(r.PlanResult, &pr); err != nil {
		return nil, err
	}
	return &pr, nil
}

// readVerifyReport decodes result.json's VerifyReport (chart_scan).
func readVerifyReport(workDir string) (*verify.Report, error) {
	b, err := os.ReadFile(filepath.Join(workDir, "result.json"))
	if err != nil {
		return nil, err
	}
	var r stageResult
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, err
	}
	if len(r.VerifyReport) == 0 {
		return nil, nil
	}
	var rep verify.Report
	if err := json.Unmarshal(r.VerifyReport, &rep); err != nil {
		return nil, err
	}
	return &rep, nil
}

// readChartWorkloads decodes result.json's ChartWorkloads (chart_scan describe output). Returns a
// nil slice when the stage emitted none (an older runner, or a chart with no described workloads).
func readChartWorkloads(workDir string) ([]types.ChartWorkload, error) {
	b, err := os.ReadFile(filepath.Join(workDir, "result.json"))
	if err != nil {
		return nil, err
	}
	var r stageResult
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, err
	}
	if len(r.ChartWorkloads) == 0 {
		return nil, nil
	}
	var wl []types.ChartWorkload
	if err := json.Unmarshal(r.ChartWorkloads, &wl); err != nil {
		return nil, err
	}
	return wl, nil
}

// readIacScanReport decodes result.json's IacReport (BYO IaC scan).
func readIacScanReport(workDir string) (*types.IacScanReport, error) {
	b, err := os.ReadFile(filepath.Join(workDir, "result.json"))
	if err != nil {
		return nil, err
	}
	var r stageResult
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, err
	}
	if len(r.IacReport) == 0 {
		return nil, nil
	}
	var rep types.IacScanReport
	if err := json.Unmarshal(r.IacReport, &rep); err != nil {
		return nil, err
	}
	return &rep, nil
}

// readDriftPosture decodes result.json's DriftPosture (BYO drift).
func readDriftPosture(workDir string) (*drift.Posture, error) {
	b, err := os.ReadFile(filepath.Join(workDir, "result.json"))
	if err != nil {
		return nil, err
	}
	var r stageResult
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, err
	}
	if len(r.DriftPosture) == 0 {
		return nil, nil
	}
	var p drift.Posture
	if err := json.Unmarshal(r.DriftPosture, &p); err != nil {
		return nil, err
	}
	return &p, nil
}
