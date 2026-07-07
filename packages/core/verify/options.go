// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package verify

import (
	"context"
	"strings"

	tfjson "github.com/hashicorp/terraform-json"
)

// PolicyChecker corroborates an IAM policy document with an external authority
// (AWS IAM Access Analyzer's automated-reasoning `CheckAccessNotGranted`). It is
// an interface so the pure verify package stays free of any cloud SDK — a real
// AWS-backed implementation lives in a separate adapter package, and tests use a
// fake. Implementations should be deterministic for a given (policy, denied) pair.
type PolicyChecker interface {
	// CheckAccessNotGranted returns the subset of `denied` actions that the policy
	// document COULD grant (empty slice = none granted = the policy passes). An
	// error means the check could not run — the caller treats that as a coverage
	// gap (not_evaluable), never as a pass.
	CheckAccessNotGranted(ctx context.Context, policyJSON string, denied []string) ([]string, error)
}

// DefaultDeniedActions is the high-blast-radius action set the Access Analyzer
// control asserts a policy does NOT grant. Kept deliberately small and specific
// (false positives here block applies).
var DefaultDeniedActions = []string{
	"iam:CreateAccessKey",
	"iam:PutUserPolicy",
	"iam:AttachUserPolicy",
	"iam:CreateUser",
	"sts:AssumeRole",
	"kms:Decrypt",
	"secretsmanager:GetSecretValue",
	"s3:DeleteBucket",
}

// Options tunes Evaluate. The zero value is the pure, offline gate.
type Options struct {
	// PolicyChecker, when set, enables the AWS IAM Access Analyzer corroboration
	// control (ACCESS-ANALYZER-001). Nil disables it.
	PolicyChecker PolicyChecker
	// DeniedActions overrides DefaultDeniedActions for the analyzer control.
	DeniedActions []string
}

// EvaluateWithOptions is Evaluate with optional Access Analyzer corroboration.
func EvaluateWithOptions(ctx context.Context, plan *tfjson.Plan, opts Options) (*Report, error) {
	rep := &Report{CatalogVersion: CatalogVersion}
	if plan == nil {
		rep.Provider = "unknown"
		rep.Verdict = StatusNotEvaluable
		return rep, nil
	}

	planned := gatherPlanned(plan)
	rep.Provider = detectProvider(planned)
	rep.Controls = selectControls(rep.Provider, planned)

	// Access Analyzer corroboration is AWS-only and opt-in (needs a checker).
	if opts.PolicyChecker != nil && (rep.Provider == "aws" || rep.Provider == "unknown") {
		denied := opts.DeniedActions
		if len(denied) == 0 {
			denied = DefaultDeniedActions
		}
		rep.Controls = append(rep.Controls, controlAccessAnalyzer(ctx, planned, opts.PolicyChecker, denied))
	}

	rep.finalize()
	return rep, nil
}

// controlAccessAnalyzer — ACCESS-ANALYZER-001. For every inline IAM policy the plan
// can see, it asks the checker whether the policy could grant any of the denied
// (high-blast) actions; any grant is a hard fail. A policy whose body is unknown,
// or a checker error, becomes not_evaluable (a coverage gap — never a silent pass).
func controlAccessAnalyzer(ctx context.Context, planned []plannedResource, checker PolicyChecker, denied []string) ControlResult {
	c := ControlResult{
		ID:         "ACCESS-ANALYZER-001",
		Title:      "No sensitive actions grantable (IAM Access Analyzer)",
		Severity:   SeverityHigh,
		Provider:   "aws",
		Frameworks: []string{"SOC2-CC6.3"},
	}
	inlineTypes := map[string]bool{
		"aws_iam_policy": true, "aws_iam_role_policy": true,
		"aws_iam_group_policy": true, "aws_iam_user_policy": true,
	}
	failed, relevant, evaluable, notEval := 0, 0, 0, 0
	var coverage []string

	for _, r := range planned {
		if !inlineTypes[r.rtype] {
			continue
		}
		relevant++
		if attrUnknown(r.afterUnknown, "policy") {
			notEval++
			coverage = append(coverage, r.address+": policy body computed until apply")
			continue
		}
		body := asString(r.after["policy"])
		if body == "" {
			notEval++
			continue
		}
		granted, err := checker.CheckAccessNotGranted(ctx, body, denied)
		if err != nil {
			notEval++
			coverage = append(coverage, r.address+": Access Analyzer check failed ("+err.Error()+")")
			continue
		}
		evaluable++
		if len(granted) > 0 {
			c.Findings = append(c.Findings, Finding{
				Address: r.address,
				Message: "policy could grant sensitive action(s): " + strings.Join(granted, ", "),
			})
			failed++
		}
	}

	resolveStatus(&c, failed, 0, evaluable, relevant, notEval, coverage)
	return c
}
