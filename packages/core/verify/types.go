// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Package verify is the deterministic policy gate that runs between `tofu plan`
// and `tofu apply` (the "elench" verification engine, Phase 0). It evaluates the
// OpenTofu plan JSON against a small set of authored security controls and
// produces a structured, honest Report: every control reports pass / fail / warn
// or — crucially — not_evaluable when the plan JSON does not contain enough
// information to judge it (e.g. a policy body that is computed/unknown until
// apply). A silent pass on an un-inspectable resource is exactly the false-PASS
// the verification headline must never produce.
//
// The Evaluate seam is intentionally engine-agnostic. Phase 0 ships a pure-Go
// evaluator (no external policy runtime, fully testable offline). Phase 1 may
// swap the engine for OPA/Rego bundles (customer-authorable controls) behind the
// same Report contract without changing any caller.
package verify

// CatalogVersion identifies the control set that produced a Report. It is part of
// the evidence: an old receipt is only meaningful against the controls + schema
// that produced it, so this version is recorded and must be bumped whenever a
// control's logic changes in a way that could alter a verdict.
const CatalogVersion = "elench-controls-0.2.0"

// Status is the outcome of a single control (or the overall verdict).
type Status string

const (
	// StatusPass — the control was evaluated and the plan satisfies it.
	StatusPass Status = "pass"
	// StatusFail — the control was evaluated and the plan violates it. On a real
	// apply this blocks (fail-closed) unless an authorized override is present.
	StatusFail Status = "fail"
	// StatusWarn — a concern that is recorded and surfaced but does not block.
	StatusWarn Status = "warn"
	// StatusNotEvaluable — the plan JSON lacks the information to judge the
	// control (computed/unknown values, managed policies referenced only by ARN,
	// resources created in another state/module). NEVER treated as a pass.
	StatusNotEvaluable Status = "not_evaluable"
)

// Severity is the risk weight of a control, surfaced in the UI/receipt.
type Severity string

const (
	SeverityHigh   Severity = "high"
	SeverityMedium Severity = "medium"
	SeverityLow    Severity = "low"
)

// Finding is a single offending (or noteworthy) resource within a control.
type Finding struct {
	// Address is the absolute resource address, e.g. aws_iam_policy.admin.
	Address string `json:"address"`
	// Message explains the specific issue for this resource.
	Message string `json:"message"`
}

// ControlResult is the outcome of one named control over the whole plan.
type ControlResult struct {
	ID       string   `json:"id"`
	Title    string   `json:"title"`
	Severity Severity `json:"severity"`
	Status   Status   `json:"status"`
	// Frameworks maps the control to external control catalogs (CIS / SOC 2 …).
	// This mapping is hand-maintained and being wrong is worse than absent, so it
	// is kept deliberately small and conservative.
	Frameworks []string `json:"frameworks,omitempty"`
	// Provider is the cloud the control covers (currently "aws"). Surfaced so a
	// uniform posture UI cannot imply coverage the control does not actually have.
	Provider string `json:"provider"`
	// Findings are the offending/noteworthy resources (empty on a clean pass).
	Findings []Finding `json:"findings,omitempty"`
	// Coverage notes, in plain language, what this control could NOT inspect on
	// this plan (the honesty surface — e.g. "1 policy body computed until apply").
	Coverage string `json:"coverage,omitempty"`
}

// Summary is a quick tally of control statuses.
type Summary struct {
	Pass         int `json:"pass"`
	Fail         int `json:"fail"`
	Warn         int `json:"warn"`
	NotEvaluable int `json:"not_evaluable"`
}

// Report is the full verification result for one plan. It is attached to the
// PlanResult, surfaced in execution_metadata, and (Phase 1) sealed into the
// signed evidence receipt.
type Report struct {
	// Verdict is the overall gate decision: fail if any control failed, else warn
	// if any warned, else pass. not_evaluable controls never produce a pass/fail
	// verdict on their own.
	Verdict Status `json:"verdict"`
	// CatalogVersion records which control set produced this report.
	CatalogVersion string `json:"catalog_version"`
	// Provider is the cloud(s) evaluated, from the plan's resource prefixes: a
	// single cloud by name ("aws"), a multi-cloud plan as a deterministic "+"-joined
	// set ("aws+azure") — every provider present has its controls run — or "unknown"
	// when no recognized cloud is found.
	Provider string          `json:"provider"`
	Controls []ControlResult `json:"controls"`
	Summary  Summary         `json:"summary"`
}

// Blocking reports whether this report should stop a real apply (fail-closed).
// Only a hard Fail blocks; warn / not_evaluable do not.
func (r *Report) Blocking() bool {
	return r != nil && r.Verdict == StatusFail
}
