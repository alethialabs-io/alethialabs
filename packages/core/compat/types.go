// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package compat

// The Report contract below mirrors packages/core/verify verbatim (Status,
// Severity, Finding, ControlResult, Summary, Report, Override, Unwaived). The
// shapes are intentionally REDECLARED here rather than imported so the two
// engines stay disjoint and independently versioned (compat-matrix-0.1.0 vs
// elench-controls-0.4.0) — the compat seam owns no verify code and vice-versa.
// The Go type names match verify (compat.Report, compat.ControlResult); the
// generated TS mirror uses CompatReport / CompatControlResult (no package
// namespace).

// Status is the outcome of a single control (or the overall verdict).
type Status string

const (
	// StatusPass — the control was evaluated and the config satisfies it.
	StatusPass Status = "pass"
	// StatusFail — the control was evaluated and the config violates it. At the
	// apply gate this blocks (fail-closed) unless an authorized override waives it.
	StatusFail Status = "fail"
	// StatusWarn — a concern that is recorded and surfaced but does not block.
	StatusWarn Status = "warn"
	// StatusNotEvaluable — the matrix has no compatibility data to judge the
	// control (an unrecorded version, or an add-on with no Kubernetes window yet).
	// NEVER treated as a pass — this is the honesty surface that prevents the
	// false-PASS a naive "no known problem" would produce.
	StatusNotEvaluable Status = "not_evaluable"
)

// Severity is the risk weight of a control, surfaced in the UI/report.
type Severity string

const (
	SeverityHigh   Severity = "high"
	SeverityMedium Severity = "medium"
	SeverityLow    Severity = "low"
)

// ControlGateID is the reserved control ID under which the fail-closed apply gate
// surfaces a blocking compat Report through the elench Unwaived/Override
// machinery. The seam engine does not emit it (it emits the granular per-coupling
// controls below); the apply-time unit (#1215) maps a blocking Report to it.
const ControlGateID = "COMPAT-001"

// Finding is a single offending (or noteworthy) subject within a control.
type Finding struct {
	// Address identifies the offending subject, e.g. "argocd@7.1.3".
	Address string `json:"address"`
	// Message explains the specific incompatibility.
	Message string `json:"message"`
}

// ControlResult is the outcome of one compatibility control over the config.
type ControlResult struct {
	ID       string   `json:"id"`
	Title    string   `json:"title"`
	Severity Severity `json:"severity"`
	Status   Status   `json:"status"`
	// Findings are the offending/noteworthy subjects (empty on a clean pass).
	Findings []Finding `json:"findings,omitempty"`
	// Coverage notes, in plain language, what this control could NOT judge (the
	// honesty surface — e.g. "no Kubernetes range recorded for add-on falco").
	Coverage string `json:"coverage,omitempty"`
}

// Summary is a quick tally of control statuses.
type Summary struct {
	Pass         int `json:"pass"`
	Fail         int `json:"fail"`
	Warn         int `json:"warn"`
	NotEvaluable int `json:"not_evaluable"`
}

// Report is the full compatibility result for one proposed config.
type Report struct {
	// Verdict is the overall decision: fail if any control failed, else warn if any
	// warned, else not_evaluable if any control could not be judged, else pass.
	Verdict Status `json:"verdict"`
	// CatalogVersion records which matrix produced this report.
	CatalogVersion string          `json:"catalog_version"`
	Controls       []ControlResult `json:"controls"`
	Summary        Summary         `json:"summary"`
}

// Blocking reports whether this report should stop a real apply (fail-closed).
// Only a hard Fail blocks; warn / not_evaluable do not.
func (r *Report) Blocking() bool {
	return r != nil && r.Verdict == StatusFail
}

// Subject is the proposed config the engine evaluates: the target cloud(s), the
// cluster Kubernetes version, and the enabled platform components + add-ons. It
// is the input contract downstream units populate (buildConfigSnapshot at config
// time; deploy.go at apply time).
type Subject struct {
	// Providers are the target cloud slugs (e.g. "aws", "hetzner").
	Providers []string `json:"providers,omitempty"`
	// K8sVersion is the cluster Kubernetes version — a bare minor ("1.35") or a
	// concrete patch ("1.35.6"); only the major.minor is compared.
	K8sVersion string `json:"k8s_version,omitempty"`
	// Components are the enabled platform components with their pinned versions.
	Components []ComponentRef `json:"components,omitempty"`
	// AddOns are the enabled add-on charts with their pinned versions.
	AddOns []AddOnRef `json:"addons,omitempty"`
}

// ComponentRef names an enabled platform component and its version.
type ComponentRef struct {
	ID      string `json:"id"`
	Version string `json:"version"`
}

// AddOnRef names an enabled add-on chart and its version.
type AddOnRef struct {
	ID      string `json:"id"`
	Version string `json:"version,omitempty"`
}
