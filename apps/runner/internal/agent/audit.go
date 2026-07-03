// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"fmt"

	"github.com/alethialabs-io/alethialabs/packages/core/verify"
)

// executeAudit runs the elench verify engine over a customer's EXISTING infrastructure
// (the "B" flow): a bring-your-own OpenTofu/Terraform `show -json` plan, or Kubernetes
// manifests. It provisions nothing — it reads the input from the job config, evaluates
// it, and posts the verify.Report to execution_metadata.verify_result (surfaced by the
// console's get_plan_result tool + VerifyBlock, exactly like a PLAN job's gate).
func (w *Runner) executeAudit(ctx context.Context, job *Job, stdout, stderr *JobLogger) error {
	kind, _ := job.ConfigSnapshot["audit_kind"].(string)
	input, _ := job.ConfigSnapshot["audit_input"].(string)
	if input == "" {
		return fmt.Errorf("audit job has no input (audit_input is empty)")
	}

	fmt.Fprintf(stdout, "Auditing bring-your-own %s with elench...\n", auditKindLabel(kind))

	var report *verify.Report
	var err error
	switch kind {
	case "manifests":
		report, err = verify.EvaluateManifests([]byte(input))
	default: // "plan" (OpenTofu/Terraform show -json)
		plan, perr := verify.ParseCustomerPlan([]byte(input))
		if perr != nil {
			return fmt.Errorf("parse plan: %w", perr)
		}
		report, err = verify.Evaluate(ctx, plan)
	}
	if err != nil {
		return fmt.Errorf("audit: %w", err)
	}

	fmt.Fprintf(stdout, "Audit verdict: %s (%d pass, %d fail, %d warn, %d not-evaluable)\n",
		report.Verdict, report.Summary.Pass, report.Summary.Fail, report.Summary.Warn,
		report.Summary.NotEvaluable)

	_ = w.api.UpdateJobStatus(job.ID, "PROCESSING", "", map[string]any{"verify_result": report})
	return nil
}

func auditKindLabel(kind string) string {
	if kind == "manifests" {
		return "Kubernetes manifests"
	}
	return "OpenTofu/Terraform plan"
}
