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

	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	"github.com/alethialabs-io/alethialabs/packages/core/provisioner"
	"github.com/alethialabs-io/alethialabs/packages/core/sandbox"
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
	StateConsoleURL      string                      `json:"state_console_url"`
	JobID                string                      `json:"job_id"`
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

// stageSecrets are per-job secrets sourced by the caller: the parent fills them from its
// scope (Passthrough); the child fills them from its allowlisted env (container).
type stageSecrets struct {
	GitToken   string
	StateToken string
}

func stageSecretsFromEnv() stageSecrets {
	return stageSecrets{
		GitToken:   os.Getenv("ALETHIA_STAGE_GIT_TOKEN"),
		StateToken: os.Getenv("TF_HTTP_PASSWORD"),
	}
}

// stageResult is written to result.json by the run*Stage functions and read back by the
// parent (readPlanResult / readVerifyReport).
type stageResult struct {
	PlanResult   json.RawMessage `json:"plan_result,omitempty"`
	VerifyReport json.RawMessage `json:"verify_report,omitempty"`
	Error        string          `json:"error,omitempty"`
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
		ProjectConfig:        &cfg,
		CloudAccountID:       vc.CloudAccountID,
		ConnectorCredentials: vc.ConnectorCredentials,
		Provider:             provider,
		DryRun:               dryRun,
		PlanFile:             planFile,
		TemplatesDir:         templatesDir,
		CategoriesDir:        categoriesDir,
		InfracostToken:       infracostToken,
		VerifyOverride:       override,
		StateConsoleURL:      stateConsoleURL,
		JobID:                jobID,
	}
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
		ProjectConfig:  vc,
		Provider:       p.Provider,
		DryRun:         p.DryRun,
		PlanFile:       p.PlanFile,
		TemplatesDir:   p.TemplatesDir,
		CategoriesDir:  p.CategoriesDir,
		InfracostToken: p.InfracostToken,
		GitAccessToken: sec.GitToken,
		StateBackend:   &cloud.HTTPBackendConfig{ConsoleURL: p.StateConsoleURL, JobID: p.JobID, Token: sec.StateToken},
		Stdout:         stdout,
		Stderr:         stderr,
		VerifyOverride: p.VerifyOverride,
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
