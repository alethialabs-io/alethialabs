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
	// configExprs are this resource's configuration expressions (from the plan's
	// `configuration` section), keyed by attribute. They let a control reason
	// honestly about a value that is computed until apply — e.g. an hcloud_server's
	// `firewall_ids = [hcloud_firewall.this.id]` collapses to after_unknown:true in
	// the change, but the configuration still shows the firewall REFERENCE. Nil when
	// the plan carries no configuration (a bare change-only plan).
	configExprs map[string]*tfjson.Expression
	// modPrefix is the module address prefix ("" for root, "module.x." inside a
	// module). Configuration references are module-local, so callers prefix them
	// with this to compare against absolute plan addresses.
	modPrefix string
	// hasCfg records whether the plan's configuration section contained this
	// resource at all (independent of whether it had any expressions).
	hasCfg bool
}

// exprRefs returns the configuration references of attribute `attr` for this
// resource, module-prefixed so they compare against absolute plan addresses.
// Empty when the plan has no configuration or the attribute is not set from a
// reference.
func (r *plannedResource) exprRefs(attr string) []string {
	if r.configExprs == nil {
		return nil
	}
	e := r.configExprs[attr]
	if e == nil || e.ExpressionData == nil {
		return nil
	}
	out := make([]string, 0, len(e.References))
	for _, ref := range e.References {
		out = append(out, r.modPrefix+ref)
	}
	return out
}

// exprConstant returns the configuration constant value of attribute `attr`, and
// whether one is present (a literal in the .tf source, e.g. firewall_ids = [123]).
func (r *plannedResource) exprConstant(attr string) (any, bool) {
	if r.configExprs == nil {
		return nil, false
	}
	e := r.configExprs[attr]
	if e == nil || e.ExpressionData == nil || e.ConstantValue == nil {
		return nil, false
	}
	return e.ConstantValue, true
}

// hasConfig reports whether the plan carried configuration for this resource at
// all — the difference between "attribute not configured" (config present, attr
// absent: a real, judgeable fact) and "we cannot see the configuration" (an
// honest not_evaluable).
func (r *plannedResource) hasConfig() bool { return r.hasCfg }

// baseAddress strips the instance key from a resource address
// (hcloud_server.workers["w-1"] → hcloud_server.workers) so it can be matched
// against configuration addresses, which are never instance-keyed.
func baseAddress(addr string) string {
	if i := strings.IndexByte(addr, '['); i > 0 {
		return addr[:i]
	}
	return addr
}

// resourceConfig pairs a configuration resource's expressions with its module
// prefix for reference resolution.
type resourceConfig struct {
	exprs     map[string]*tfjson.Expression
	modPrefix string
}

// configExprIndex walks the plan's configuration and indexes each resource's
// expressions by its module-prefixed base address. Returns nil when the plan has
// no configuration section (callers then treat config-dependent judgments as
// not_evaluable rather than guessing).
func configExprIndex(plan *tfjson.Plan) map[string]resourceConfig {
	if plan.Config == nil || plan.Config.RootModule == nil {
		return nil
	}
	out := map[string]resourceConfig{}
	var walk func(m *tfjson.ConfigModule, prefix string)
	walk = func(m *tfjson.ConfigModule, prefix string) {
		if m == nil {
			return
		}
		for _, cr := range m.Resources {
			if cr == nil {
				continue
			}
			out[prefix+cr.Address] = resourceConfig{exprs: cr.Expressions, modPrefix: prefix}
		}
		for name, mc := range m.ModuleCalls {
			if mc != nil {
				walk(mc.Module, prefix+"module."+name+".")
			}
		}
	}
	walk(plan.Config.RootModule, "")
	return out
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
		out = append(out, hetznerControls(planned)...)
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
		case "hetzner":
			out = append(out, hetznerControls(planned)...)
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
	cfg := configExprIndex(plan)
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
		pr := plannedResource{
			address:      rc.Address,
			rtype:        rc.Type,
			provider:     rc.ProviderName,
			after:        after,
			afterUnknown: rc.Change.AfterUnknown,
		}
		if rcfg, ok := cfg[baseAddress(rc.Address)]; ok {
			pr.configExprs = rcfg.exprs
			pr.modPrefix = rcfg.modPrefix
			pr.hasCfg = true
		}
		out = append(out, pr)
	}
	return out
}

// detectProviders returns the deterministic sorted SET of recognized cloud
// providers present in the plan (from resource-type prefixes). A plan may span
// several clouds, so this is a set rather than a single best-effort guess: every
// provider in it gets its controls run (see selectControls). Resource types with no
// recognized prefix (utility providers like random_/tls_, or clouds without a
// control set such as cloudflare) contribute nothing here — the engine has no
// controls to run over them, which the report states honestly rather than implying a
// pass it never checked. hcloud_ IS recognized now (→ "hetzner"), so a Hetzner plan
// runs the posture control set rather than being a vacuous pass.
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
		case strings.HasPrefix(r.rtype, "hcloud_"):
			seen["hetzner"] = true
		}
	}
	out := make([]string, 0, len(seen))
	for p := range seen {
		out = append(out, p)
	}
	sort.Strings(out)
	return out
}

// controlledProviderTokens are the resource-type prefixes (the segment before the
// first underscore) that have an authored control set — a violation in one of these
// providers is actually checked. Note "google" maps to the gcp control set and both
// "azurerm"/"azuread" map to the azure set; the token is the raw terraform prefix.
// "hcloud" is controlled by the Hetzner POSTURE set (firewall/network) — Hetzner is
// token-auth with no keyless/OIDC surface, so those controls are network-shaped, not
// authority-shaped, but the plan is genuinely inspected rather than vacuously passed.
var controlledProviderTokens = map[string]bool{
	"aws": true, "google": true, "azurerm": true, "azuread": true, "hcloud": true,
}

// supportedNoControlProviderTokens are provider prefixes the engine recognizes as a
// LEGITIMATE vacuous pass: providers for which there is no control surface to assert,
// so a plan built only from them is honestly a pass. Two groups:
//
//   - Clouds without a control set BY DESIGN. Cloudflare is token-auth with no
//     keyless/OIDC surface AND (unlike Hetzner) no server/firewall posture the gate
//     yet inspects, so it stays here. NB Hetzner (hcloud) is NO LONGER here: it now
//     has an authored POSTURE control set (see hetznerControls / controls_hetzner.go)
//     — token-auth is still the ceiling, but its firewall/network config is a real,
//     inspectable attack surface, so it moved into controlledProviderTokens.
//   - CLUSTER-LAYER providers that create NO cloud-authority surface — the K8s
//     bootstrap + in-cluster resources that co-occur in every real cluster plan
//     (talos_, imager_, minio_, helm_, kubernetes_, kubectl_). None of them create a
//     cloud IAM identity / keyless-federation / least-priv surface (the only thing the
//     controls audit); they configure the cluster itself. Alethia's shipped Hetzner
//     template is hcloud_ + talos_ + imager_ + minio_ + helm_, so WITHOUT this group a
//     real Hetzner/Talos provision would wrongly flip pass → not_evaluable.
//   - Utility providers that create no cloud authority at all: random_, tls_, null_,
//     local_, time_, external_.
//
// NB this is a CLOUD-AUTHORITY allowlist, not a managed-cloud allowlist: `alicloud` is a
// managed cloud but has NO authored control set yet, so it is deliberately LEFT OFF —
// an Alibaba plan is honestly not_evaluable until alicloud controls exist (it has RAM/OIDC
// authority, so it must eventually get real controls, not this allowlist).
//
// This allowlist is what makes the fail-closed backstop (controlEvaluableScope) safe:
// it must NOT flip these legitimate plans to not_evaluable, only genuinely
// unrecognized providers. When in doubt a provider is left OFF this list (the
// fail-closed default) so an unknown cloud is surfaced rather than silently passed.
var supportedNoControlProviderTokens = map[string]bool{
	"cloudflare": true,
	// cluster-layer, no cloud-authority surface (co-occur in every real cluster plan):
	"talos": true, "imager": true, "minio": true,
	"helm": true, "kubernetes": true, "kubectl": true,
	// pure utility:
	"random": true, "tls": true, "null": true,
	"local": true, "time": true, "external": true,
}

// providerToken extracts the terraform provider prefix from a resource type — the
// segment before the first underscore (aws_iam_role → "aws", hcloud_server →
// "hcloud", awscc_s3_bucket → "awscc", random_id → "random"). A type with no
// underscore is returned whole (e.g. the "external" data-source type). This is how a
// resource is bucketed as controlled / supported-no-controls / unrecognized.
func providerToken(rtype string) string {
	if i := strings.IndexByte(rtype, '_'); i > 0 {
		return rtype[:i]
	}
	return rtype
}

// controlEvaluableScope — SCOPE-001. The fail-closed backstop for the whole gate.
// detectProviders + the per-cloud controls are all resource-type-filtered, so a plan
// whose resources belong to NO controlled provider runs every control set to a
// "nothing in scope" vacuous pass — historically a silent PASS even for a plan the
// gate cannot reason about at all (a typo'd/custom provider, or AWS Cloud Control
// `awscc_`, whose resources the `aws_` controls never match). That is the exact
// false-PASS this package must never make.
//
// This control asserts the plan is EVALUABLE: every managed resource must belong to a
// provider we recognize — either a controlled cloud (aws/gcp/azure, whose controls
// ran) or a supported-no-controls provider (Hetzner/Cloudflare/utility, a legitimate
// vacuous pass). A resource from any OTHER provider means the gate cannot see the
// authority that resource creates, so the report is not_evaluable (honest per-resource
// note naming the unrecognized provider) rather than a pass over uninspected infra. It
// does NOT deny — a controlled cloud's real violation still hard-fails and blocks; an
// unrecognized provider only demotes an otherwise-clean plan from pass to not_evaluable.
func controlEvaluableScope(planned []plannedResource) ControlResult {
	c := ControlResult{
		ID:         "SCOPE-001",
		Title:      "Plan is within the engine's evaluable scope",
		Severity:   SeverityHigh,
		Provider:   "all",
		Frameworks: []string{"SOC2-CC6.1"},
		Status:     StatusPass,
	}
	var coverage []string
	for _, r := range planned { // plan order → deterministic
		tok := providerToken(r.rtype)
		if controlledProviderTokens[tok] || supportedNoControlProviderTokens[tok] {
			continue
		}
		c.Findings = append(c.Findings, Finding{
			Address: r.address,
			Message: "unrecognized provider \"" + tok + "\" (resource type " + r.rtype + "): no control set covers it and it is not on the supported-no-controls allowlist — the gate cannot reason about the authority this resource creates, so the plan is not_evaluable rather than passed",
		})
		coverage = append(coverage, r.address+": unrecognized provider "+tok)
	}
	if len(c.Findings) > 0 {
		c.Status = StatusNotEvaluable
		c.Coverage = strings.Join(coverage, "; ")
	}
	return c
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
