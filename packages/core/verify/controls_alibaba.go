// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package verify

import "strings"

// alibabaControls is the Alibaba Cloud (alicloud) control set.
//
// Unlike Hetzner (token-auth, network-posture only), Alibaba has a REAL RAM/OIDC
// authority surface: RRSA — RAM Roles for Service Accounts — is its OIDC
// workload-identity mechanism (the analogue of AWS IRSA / GCP WIF), and RAM policies
// grant the same over-broad footguns AWS IAM does. So this set MIRRORS the AWS one:
//
//   - ALI-KEYLESS-001: no static RAM access keys (use RRSA / AssumeRoleWithOIDC).
//   - ALI-OIDC-001: every RAM role whose trust document has a Federated (OIDC/RRSA)
//     principal must bind `oidc:sub` to a non-wildcard value.
//   - ALI-LEASTPRIV-001: no `Action:"*"` on `Resource:"*"` and no `Allow`+`NotAction`
//     RAM policy body; no attachment — to a role, user, OR group — of an admin-family
//     System managed policy (all hard fails); a service-level wildcard (`ecs:*` on `*`)
//     is a warn; a non-admin System attachment (body not in the plan) is not_evaluable.
//
// PLAN-SHAPE NOTE (verified against OpenTofu 1.12.3 + aliyun/alicloud v1.285.0 — see
// the _comment in every alibaba_* corpus fixture, all real `tofu show -json` output):
//
//   - An alicloud_ram_role's writable trust attribute is `assume_role_policy_document`
//     (a JSON string). The provider ALSO exposes a read-only, computed `document`
//     mirror that is `after_unknown:true` on a create plan — so the trust judgment MUST
//     read `assume_role_policy_document` (known) and never the computed `document`
//     mirror (which would be a spurious not_evaluable). Older provider versions used
//     `document` as the writable trust attr, so parseALITrust falls back to it.
//   - An alicloud_ram_policy body is on `policy_document` (writable, known); `document`
//     is again the computed read-only mirror. parseALIPolicy reads `policy_document`
//     first, falling back to `document`.
//   - Alibaba RAM documents use `Version:"1"` and the SAME Effect/Action/Resource/
//     Principal/Condition shape as AWS IAM, so parseIAMPolicy + subjectIsBound are
//     reused verbatim. The only Alibaba-specific difference is the trust ACTION
//     (`sts:AssumeRole`, not AWS's `sts:AssumeRoleWithWebIdentity`) — hence a dedicated
//     isALIFederatedTrust.
func alibabaControls(planned []plannedResource) []ControlResult {
	return []ControlResult{
		controlALINoStaticKeys(planned),
		controlALIFederatedTrust(planned),
		controlALILeastPrivilege(planned),
	}
}

// controlALINoStaticKeys — ALI-KEYLESS-001 (hard fail). Creating an
// alicloud_ram_access_key is the Alibaba equivalent of a long-lived static
// credential — a clean binary fact in the plan. Use RRSA (keyless) instead.
func controlALINoStaticKeys(planned []plannedResource) ControlResult {
	c := ControlResult{
		ID:         "ALI-KEYLESS-001",
		Title:      "No static RAM access keys",
		Severity:   SeverityHigh,
		Provider:   "alibaba",
		Frameworks: []string{"SOC2-CC6.1"},
		Status:     StatusPass,
	}
	for _, r := range planned {
		if r.rtype == "alicloud_ram_access_key" {
			c.Findings = append(c.Findings, Finding{
				Address: r.address,
				Message: "creates a long-lived static RAM access key; use RRSA (RAM Roles for Service Accounts) / AssumeRoleWithOIDC instead",
			})
		}
	}
	if len(c.Findings) > 0 {
		c.Status = StatusFail
	}
	return c
}

// controlALIFederatedTrust — ALI-OIDC-001. For every RAM role whose trust document
// uses a Federated (RRSA/OIDC) principal, require the assumption is bound to a
// specific subject. A missing `oidc:sub`, or one constrained only with a StringLike
// wildcard, lets ANY pod/ServiceAccount from the cluster's OIDC issuer assume the
// role — a hard fail. Roles trusted by a Service principal (ECS/service roles) carry
// no Federated principal and are out of scope. A trust document that is computed
// until apply is per-resource not_evaluable (never a silent pass).
func controlALIFederatedTrust(planned []plannedResource) ControlResult {
	c := ControlResult{
		ID:         "ALI-OIDC-001",
		Title:      "RRSA trust is bound to a specific subject",
		Severity:   SeverityHigh,
		Provider:   "alibaba",
		Frameworks: []string{"SOC2-CC6.1"},
	}
	relevant, evaluable, notEval := 0, 0, 0
	var coverage []string

	for _, r := range planned {
		if r.rtype != "alicloud_ram_role" {
			continue
		}
		doc, present, ok := parseALITrust(r)
		if !present {
			continue
		}
		if !ok {
			notEval++
			relevant++
			coverage = append(coverage, r.address+": assume-role trust document not known until apply")
			continue
		}
		federated := false
		for _, st := range doc.Statements {
			if !isALIFederatedTrust(st) {
				continue
			}
			federated = true
			safe, why := subjectIsBound(st)
			if !safe {
				c.Findings = append(c.Findings, Finding{Address: r.address, Message: why})
			}
		}
		if !federated {
			continue // service role (Service principal), not in scope for RRSA binding
		}
		relevant++
		evaluable++
	}

	resolveStatus(&c, len(c.Findings), 0, evaluable, relevant, notEval, coverage)
	return c
}

// aliAttachTypes are the RAM policy-attachment resource types — the principal an
// admin policy is attached TO does not change its blast radius, so role, user, and
// group attachments are all in scope (mirroring the AWS twin's role/user/group set).
var aliAttachTypes = map[string]bool{
	"alicloud_ram_role_policy_attachment":  true,
	"alicloud_ram_user_policy_attachment":  true,
	"alicloud_ram_group_policy_attachment": true,
}

// controlALILeastPrivilege — ALI-LEASTPRIV-001. Inspect the RAM policy bodies the
// plan can see and flag over-broad grants, and hard-fail an attachment (to a role,
// user, or group) of an admin-family System managed policy. Honest about blind
// spots: a policy body that is computed until apply, or a non-admin System policy
// (whose body is never in the plan), is reported as a coverage gap / not_evaluable —
// never a silent pass. This control claims "named over-broad patterns", not "catches
// all over-permission".
func controlALILeastPrivilege(planned []plannedResource) ControlResult {
	c := ControlResult{
		ID:         "ALI-LEASTPRIV-001",
		Title:      "No over-broad RAM grants (named patterns)",
		Severity:   SeverityHigh,
		Provider:   "alibaba",
		Frameworks: []string{"SOC2-CC6.3"},
	}

	failed, warned := 0, 0
	relevant, evaluable, notEval := 0, 0, 0
	var coverage []string

	for _, r := range planned {
		switch {
		case r.rtype == "alicloud_ram_policy":
			relevant++
			doc, present, ok := parseALIPolicy(r)
			if !present {
				notEval++
				continue
			}
			if !ok {
				notEval++
				coverage = append(coverage, r.address+": policy_document computed until apply")
				continue
			}
			evaluable++
			findings, f, w := inspectALIPolicyDoc(r.address, doc)
			failed += f
			warned += w
			c.Findings = append(c.Findings, findings...)
		case aliAttachTypes[r.rtype]:
			relevant++
			if attrUnknown(r.afterUnknown, "policy_type") || attrUnknown(r.afterUnknown, "policy_name") {
				notEval++
				coverage = append(coverage, r.address+": policy_type/policy_name not known until apply")
				continue
			}
			ptype := asString(r.after["policy_type"])
			pname := asString(r.after["policy_name"])
			if ptype == "" || pname == "" {
				notEval++
				continue
			}
			if strings.EqualFold(ptype, "System") {
				if isALIAdminSystemPolicy(pname) {
					failed++
					c.Findings = append(c.Findings, Finding{
						Address: r.address,
						Message: "attaches over-broad System managed policy " + pname + " (administrative access) — attach a least-privilege Custom policy instead",
					})
					continue
				}
				// A non-admin System policy: its body is NEVER in the plan (Alibaba
				// manages it), so we cannot fully judge it — an honest coverage gap,
				// mirroring AWS's managed-policy-by-ARN handling.
				coverage = append(coverage, r.address+": System managed policy body not in plan ("+pname+")")
				notEval++
				continue
			}
			// A Custom attachment: its body is the alicloud_ram_policy judged above
			// (or pre-existing outside this plan) — the attachment itself is inspected.
			evaluable++
		}
	}

	resolveStatus(&c, failed, warned, evaluable, relevant, notEval, coverage)
	return c
}

// inspectALIPolicyDoc flags over-broad statements in a parsed RAM policy and returns
// the findings plus the number of hard (fail) and soft (warn) ones.
func inspectALIPolicyDoc(address string, doc *iamDoc) (findings []Finding, failed, warned int) {
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
		if hits := serviceWildcardActions(st.Action); len(hits) > 0 && hasWildcard(st.Resource) {
			findings = append(findings, Finding{Address: address, Message: "grants service-wildcard action(s) " + strings.Join(hits, ", ") + ` on Resource:"*" — scope to specific actions and resources`})
			warned++
		}
	}
	return findings, failed, warned
}

// parseALITrust parses a RAM role's assume-role (trust) document. It reads the
// writable `assume_role_policy_document` first (the current provider spelling) and
// falls back to `document` (older provider versions, where `document` WAS the
// writable trust attr). NB on the current provider the role ALSO exposes a computed
// read-only `document` mirror — reading `assume_role_policy_document` first avoids
// mis-reading that mirror as not_evaluable.
func parseALITrust(r plannedResource) (doc *iamDoc, present, evaluable bool) {
	doc, present, evaluable = parseIAMPolicy(r.after, r.afterUnknown, "assume_role_policy_document")
	if present {
		return doc, present, evaluable
	}
	return parseIAMPolicy(r.after, r.afterUnknown, "document")
}

// parseALIPolicy parses a RAM policy body. It reads the writable `policy_document`
// first, falling back to `document` (the computed read-only mirror / older spelling).
func parseALIPolicy(r plannedResource) (doc *iamDoc, present, evaluable bool) {
	doc, present, evaluable = parseIAMPolicy(r.after, r.afterUnknown, "policy_document")
	if present {
		return doc, present, evaluable
	}
	return parseIAMPolicy(r.after, r.afterUnknown, "document")
}

// isALIFederatedTrust reports whether a RAM trust statement allows sts:AssumeRole for
// a Federated (RRSA/OIDC) principal. This is the Alibaba analogue of AWS's
// isFederatedWebIdentity — the difference is the action (`sts:AssumeRole`, whereas AWS
// uses `sts:AssumeRoleWithWebIdentity`).
func isALIFederatedTrust(st iamStatement) bool {
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
		if strings.EqualFold(a, "sts:AssumeRole") {
			return true
		}
	}
	return false
}

// isALIAdminSystemPolicy reports whether a System-managed policy name is in the
// Alibaba admin family we hard-fail on when attached. The defensible set (mirroring
// AWS's AdministratorAccess/PowerUserAccess/IAMFullAccess):
//
//   - AdministratorAccess: full account admin — the god-mode grant.
//   - AliyunRAMFullAccess: full control of RAM itself — a principal that can create
//     users/roles/policies and attach anything IS an admin one hop away (the exact
//     self-escalation AWS's IAMFullAccess entry catches).
//
// Deliberately NOT in the family: AliyunSTSAssumeRoleAccess (grants the sts:AssumeRole
// CALL, but every assumption is still gated by the target role's trust policy — which
// ALI-OIDC-001 audits — so it is not intrinsically admin; it lands in the honest
// non-admin-System not_evaluable bucket like every other System policy), and Alibaba
// has no PowerUserAccess analogue (its service-scoped FullAccess policies, e.g.
// AliyunECSFullAccess, are single-service — broad, but not account-admin; also the
// not_evaluable bucket rather than a false hard fail).
func isALIAdminSystemPolicy(name string) bool {
	return strings.EqualFold(name, "AdministratorAccess") ||
		strings.EqualFold(name, "AliyunRAMFullAccess")
}

// serviceWildcardActions returns the service-scoped wildcard actions (e.g. "ecs:*",
// "oss:*") in a list — an action of the form `<service>:*`. The bare `*` admin grant
// is excluded (that is a hard fail handled separately, not a service wildcard).
func serviceWildcardActions(actions []string) []string {
	var hits []string
	for _, a := range actions {
		if a == "*" {
			continue
		}
		if strings.HasSuffix(a, ":*") {
			hits = append(hits, a)
		}
	}
	return hits
}
