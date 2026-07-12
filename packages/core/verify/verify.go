// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package verify

import (
	"context"
	"sort"
	"strings"

	tfjson "github.com/hashicorp/terraform-json"
)

// plannedResource is a managed resource that the plan will create/update/replace,
// reduced to what the controls need.
type plannedResource struct {
	address      string
	rtype        string
	provider     string
	after        map[string]any
	afterUnknown any
}

// Evaluate runs the authored control set against a parsed OpenTofu plan and
// returns a structured Report. It is deterministic and side-effect free: the same
// plan always yields the same verdict (the property the evidence receipt relies
// on). A nil plan yields a not_evaluable report rather than an error so callers
// can fail-closed without special-casing.
//
// The pure-Go control set ignores ctx; it is honoured by the optional Access
// Analyzer corroboration (see EvaluateWithOptions), which makes network calls.
func Evaluate(ctx context.Context, plan *tfjson.Plan) (*Report, error) {
	return EvaluateWithOptions(ctx, plan, Options{})
}

// selectControls runs the control sets for EVERY recognized cloud provider present
// in the plan — not just one. A single OpenTofu plan can mix providers (an AWS EKS
// cluster alongside an Azure role assignment, a cross-cloud migration, …); picking a
// single provider would silently skip the other clouds' controls, letting their
// keyless / least-privilege / OIDC-sub violations through unchecked. So each present
// provider contributes its own control set, and — because every control already
// filters to its own resource types — each control is scoped to only that provider's
// resources. `providers` is the deterministic sorted set from detectProviders.
//
// Fail-closed default: when NO provider is recognized (empty set), run all control
// sets rather than none, so a plan whose cloud we can't identify is never silently
// waved through with zero checks.
func selectControls(providers []string, planned []plannedResource) []ControlResult {
	if len(providers) == 0 {
		out := awsControls(planned)
		out = append(out, gcpControls(planned)...)
		out = append(out, azureControls(planned)...)
		return out
	}
	var out []ControlResult
	for _, p := range providers { // sorted → deterministic control order
		switch p {
		case "aws":
			out = append(out, awsControls(planned)...)
		case "gcp":
			out = append(out, gcpControls(planned)...)
		case "azure":
			out = append(out, azureControls(planned)...)
		}
	}
	return out
}

// awsControls is the AWS control set.
func awsControls(planned []plannedResource) []ControlResult {
	return []ControlResult{
		controlNoStaticKeys(planned),
		controlFederatedTrust(planned),
		controlLeastPrivilege(planned),
	}
}

// gatherPlanned reduces the plan's resource changes to the managed resources that
// are being created/updated/replaced (skipping data sources, no-ops and pure
// deletes, whose `after` is absent and which create no new authority).
func gatherPlanned(plan *tfjson.Plan) []plannedResource {
	var out []plannedResource
	for _, rc := range plan.ResourceChanges {
		if rc == nil || rc.Change == nil {
			continue
		}
		if rc.Mode == tfjson.DataResourceMode {
			continue
		}
		if rc.Change.Actions.NoOp() {
			continue
		}
		after, ok := asObject(rc.Change.After)
		if !ok {
			continue // delete (after is null) or a non-object body
		}
		out = append(out, plannedResource{
			address:      rc.Address,
			rtype:        rc.Type,
			provider:     rc.ProviderName,
			after:        after,
			afterUnknown: rc.Change.AfterUnknown,
		})
	}
	return out
}

// detectProviders returns the deterministic sorted SET of recognized cloud
// providers present in the plan (from resource-type prefixes). A plan may span
// several clouds, so this is a set rather than a single best-effort guess: every
// provider in it gets its controls run (see selectControls). Resource types with no
// recognized prefix (utility providers like random_/tls_, or clouds without a
// control set such as hcloud/cloudflare) contribute nothing here — the engine has no
// controls to run over them, which the report states honestly rather than implying a
// pass it never checked.
func detectProviders(planned []plannedResource) []string {
	seen := map[string]bool{}
	for _, r := range planned {
		switch {
		case strings.HasPrefix(r.rtype, "aws_"):
			seen["aws"] = true
		case strings.HasPrefix(r.rtype, "google_"):
			seen["gcp"] = true
		case strings.HasPrefix(r.rtype, "azurerm_"), strings.HasPrefix(r.rtype, "azuread_"):
			seen["azure"] = true
		}
	}
	out := make([]string, 0, len(seen))
	for p := range seen {
		out = append(out, p)
	}
	sort.Strings(out)
	return out
}

// providerLabel renders the detected provider set for the Report.Provider field: a
// single cloud by name ("aws"), a multi-cloud plan as a deterministic "+"-joined set
// ("aws+azure"), and a plan with no recognized cloud as "unknown".
func providerLabel(providers []string) string {
	if len(providers) == 0 {
		return "unknown"
	}
	return strings.Join(providers, "+")
}

// controlNoStaticKeys — KEYLESS-001. A long-lived static IAM access key is the
// clearest possible violation of the keyless posture, and it is a clean binary
// fact in the plan (the resource is either created or it is not). Hard fail.
func controlNoStaticKeys(planned []plannedResource) ControlResult {
	c := ControlResult{
		ID:         "KEYLESS-001",
		Title:      "No static IAM access keys",
		Severity:   SeverityHigh,
		Provider:   "aws",
		Frameworks: []string{"CIS-AWS-1.4", "SOC2-CC6.1"},
		Status:     StatusPass,
	}
	for _, r := range planned {
		if r.rtype == "aws_iam_access_key" {
			c.Findings = append(c.Findings, Finding{
				Address: r.address,
				Message: "creates a long-lived static IAM access key; use OIDC federation (IRSA/WIF/AssumeRoleWithWebIdentity) instead",
			})
		}
	}
	if len(c.Findings) > 0 {
		c.Status = StatusFail
	}
	return c
}

// controlFederatedTrust — OIDC-001. For every IAM role whose trust policy uses a
// federated (OIDC) principal, require that assumption is bound to a specific
// subject. The documented footgun is a `sub` constrained only with StringLike +
// a wildcard (e.g. repo:org/*:*), which lets ANY subject from the IdP assume the
// role — so a wildcard `sub`, or a missing `sub` entirely, is a hard fail. Roles
// without a federated principal (service roles) are out of scope for this control.
func controlFederatedTrust(planned []plannedResource) ControlResult {
	c := ControlResult{
		ID:         "OIDC-001",
		Title:      "Federated trust is bound to a specific subject",
		Severity:   SeverityHigh,
		Provider:   "aws",
		Frameworks: []string{"SOC2-CC6.1"},
	}
	relevant, evaluable, notEval := 0, 0, 0
	var coverage []string

	for _, r := range planned {
		if r.rtype != "aws_iam_role" {
			continue
		}
		doc, present, ok := parseIAMPolicy(r.after, r.afterUnknown, "assume_role_policy")
		if !present {
			continue
		}
		if !ok {
			notEval++
			relevant++
			coverage = append(coverage, r.address+": assume_role_policy not known until apply")
			continue
		}
		federated := false
		for _, st := range doc.Statements {
			if !isFederatedWebIdentity(st) {
				continue
			}
			federated = true
			safe, why := subjectIsBound(st)
			if !safe {
				c.Findings = append(c.Findings, Finding{Address: r.address, Message: why})
			}
		}
		if !federated {
			continue // service role, not in scope for federation binding
		}
		relevant++
		evaluable++
	}

	resolveStatus(&c, len(c.Findings), 0, evaluable, relevant, notEval, coverage)
	return c
}

// controlLeastPrivilege — LEASTPRIV-001. Inspect inline/managed IAM policy bodies
// the plan can actually see and flag over-broad grants. Honest about blind spots:
// a body that is computed until apply, or a managed policy referenced only by ARN
// (whose body is not in the plan), is reported as coverage gap / not_evaluable —
// never a silent pass. This control claims "named over-broad patterns", not
// "catches all over-permission".
func controlLeastPrivilege(planned []plannedResource) ControlResult {
	c := ControlResult{
		ID:         "LEASTPRIV-001",
		Title:      "No over-broad IAM grants (named patterns)",
		Severity:   SeverityHigh,
		Provider:   "aws",
		Frameworks: []string{"CIS-AWS-1.16", "SOC2-CC6.3"},
	}
	inlineTypes := map[string]bool{
		"aws_iam_policy": true, "aws_iam_role_policy": true,
		"aws_iam_group_policy": true, "aws_iam_user_policy": true,
	}
	attachTypes := map[string]bool{
		"aws_iam_role_policy_attachment": true, "aws_iam_user_policy_attachment": true,
		"aws_iam_group_policy_attachment": true, "aws_iam_policy_attachment": true,
	}

	failed, warned := 0, 0
	relevant, evaluable, notEval := 0, 0, 0
	var coverage []string

	for _, r := range planned {
		switch {
		case inlineTypes[r.rtype]:
			relevant++
			doc, present, ok := parseIAMPolicy(r.after, r.afterUnknown, "policy")
			if !present {
				notEval++
				continue
			}
			if !ok {
				notEval++
				coverage = append(coverage, r.address+": policy body computed until apply")
				continue
			}
			evaluable++
			findings, f, w := inspectPolicyDoc(r.address, doc)
			failed += f
			warned += w
			c.Findings = append(c.Findings, findings...)
		case attachTypes[r.rtype]:
			relevant++
			if attrUnknown(r.afterUnknown, "policy_arn") {
				notEval++
				coverage = append(coverage, r.address+": policy_arn not known until apply")
				continue
			}
			arn := asString(r.after["policy_arn"])
			if arn == "" {
				notEval++
				continue
			}
			if isAdminManagedPolicy(arn) {
				failed++
				c.Findings = append(c.Findings, Finding{Address: r.address, Message: "attaches over-broad AWS-managed policy " + shortARN(arn)})
				continue
			}
			if strings.Contains(arn, ":aws:policy/") {
				// AWS-managed (non-admin): body not in the plan, can't fully judge.
				coverage = append(coverage, r.address+": AWS-managed policy body not in plan ("+shortARN(arn)+")")
				notEval++
				continue
			}
			evaluable++ // customer-managed-by-name attachment with a concrete arn
		}
	}

	resolveStatus(&c, failed, warned, evaluable, relevant, notEval, coverage)
	return c
}

// inspectPolicyDoc flags over-broad statements in a parsed policy and returns the
// findings plus the number of hard (fail) and soft (warn) ones.
func inspectPolicyDoc(address string, doc *iamDoc) (findings []Finding, failed, warned int) {
	for _, st := range doc.Statements {
		if !strings.EqualFold(st.Effect, "Allow") {
			continue
		}
		if hasWildcard(st.Action) && hasWildcard(st.Resource) {
			findings = append(findings, Finding{Address: address, Message: `grants Action:"*" on Resource:"*" (full administrative access)`})
			failed++
			continue
		}
		if len(st.NotAction) > 0 {
			findings = append(findings, Finding{Address: address, Message: "uses Allow + NotAction (grants all actions except a listed few — effectively over-broad)"})
			failed++
			continue
		}
		if hits := sensitiveServiceWildcards(st.Action); len(hits) > 0 && hasWildcard(st.Resource) {
			findings = append(findings, Finding{Address: address, Message: "grants service-wildcard on sensitive service(s) " + strings.Join(hits, ", ") + ` with Resource:"*"`})
			warned++
		}
	}
	return findings, failed, warned
}

// isFederatedWebIdentity reports whether a trust statement allows
// sts:AssumeRoleWithWebIdentity for a Federated principal (an OIDC trust).
func isFederatedWebIdentity(st iamStatement) bool {
	if !strings.EqualFold(st.Effect, "Allow") {
		return false
	}
	if st.Principal == nil {
		return false
	}
	if _, ok := st.Principal["Federated"]; !ok {
		return false
	}
	for _, a := range st.Action {
		if strings.EqualFold(a, "sts:AssumeRoleWithWebIdentity") {
			return true
		}
	}
	return false
}

// subjectIsBound checks that a federated trust statement constrains the `:sub`
// claim to a concrete value. Returns (false, reason) when the sub is missing or
// constrained only by a wildcard StringLike — the exact "any repo can assume"
// vulnerability the headline must catch.
func subjectIsBound(st iamStatement) (bool, string) {
	hasSub := false
	for op, raw := range st.Condition {
		condMap, ok := asObject(raw)
		if !ok {
			continue
		}
		isLike := strings.Contains(strings.ToLower(op), "like")
		for key, val := range condMap {
			if !strings.HasSuffix(strings.ToLower(key), ":sub") {
				continue
			}
			hasSub = true
			for _, v := range toStringSlice(val) {
				if isLike && strings.Contains(v, "*") {
					return false, "federated trust binds `sub` with a wildcard (StringLike " + v + ") — any subject from the IdP can assume this role; pin the exact subject with StringEquals"
				}
			}
		}
	}
	if !hasSub {
		return false, "federated trust has no `:sub` condition — any identity from the OIDC provider can assume this role"
	}
	return true, ""
}

// isAdminManagedPolicy reports whether an ARN is one of the broad AWS-managed
// admin policies we hard-fail on.
func isAdminManagedPolicy(arn string) bool {
	return strings.HasSuffix(arn, ":policy/AdministratorAccess") ||
		strings.HasSuffix(arn, ":policy/PowerUserAccess") ||
		strings.HasSuffix(arn, ":policy/IAMFullAccess")
}

func shortARN(arn string) string {
	if i := strings.LastIndex(arn, "/"); i >= 0 && i+1 < len(arn) {
		return arn[i+1:]
	}
	return arn
}

// resolveStatus folds a control's counts into a single Status and attaches any
// coverage notes. Order of precedence: any hard fail → fail; else any warn →
// warn; else if anything was actually inspected → pass; else if relevant
// resources existed but none could be inspected → not_evaluable; else (no
// relevant resources at all) → vacuous pass.
func resolveStatus(c *ControlResult, failed, warned, evaluable, relevant, notEval int, coverage []string) {
	if len(coverage) > 0 {
		c.Coverage = strings.Join(coverage, "; ")
	}
	switch {
	case failed > 0:
		c.Status = StatusFail
	case warned > 0:
		c.Status = StatusWarn
	case evaluable > 0:
		c.Status = StatusPass
	case relevant > 0 && notEval > 0:
		c.Status = StatusNotEvaluable
	default:
		c.Status = StatusPass
		if relevant == 0 && c.Coverage == "" {
			c.Coverage = "no resources in scope for this control in this plan"
		}
	}
}

// finalize computes the summary tally and the overall verdict.
func (r *Report) finalize() {
	for _, c := range r.Controls {
		switch c.Status {
		case StatusPass:
			r.Summary.Pass++
		case StatusFail:
			r.Summary.Fail++
		case StatusWarn:
			r.Summary.Warn++
		case StatusNotEvaluable:
			r.Summary.NotEvaluable++
		}
	}
	// Precedence: a hard fail blocks; else a warn; else — and this is the honesty
	// rule — if any in-scope control could not be evaluated we report
	// not_evaluable rather than a vacuous pass (the receipt must never imply we
	// checked something we couldn't see). Only a plan where every in-scope control
	// genuinely passed yields pass.
	switch {
	case r.Summary.Fail > 0:
		r.Verdict = StatusFail
	case r.Summary.Warn > 0:
		r.Verdict = StatusWarn
	case r.Summary.NotEvaluable > 0:
		r.Verdict = StatusNotEvaluable
	case r.Summary.Pass > 0:
		r.Verdict = StatusPass
	default:
		r.Verdict = StatusNotEvaluable
	}
}
