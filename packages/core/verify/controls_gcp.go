// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package verify

import "strings"

// gcpControls mirrors the AWS control set for Google Cloud: no static service-
// account keys, federated (WIF) trust must be condition-bound, and no project-wide
// primitive roles. Each is parseable deterministically from the plan JSON.
func gcpControls(planned []plannedResource) []ControlResult {
	return []ControlResult{
		controlGCPNoStaticKeys(planned),
		controlGCPWorkloadIdentity(planned),
		controlGCPLeastPrivilege(planned),
	}
}

// controlGCPNoStaticKeys — GCP-KEYLESS-001. Creating a service-account *key* is the
// GCP equivalent of a long-lived static credential; use Workload Identity instead.
func controlGCPNoStaticKeys(planned []plannedResource) ControlResult {
	c := ControlResult{
		ID:         "GCP-KEYLESS-001",
		Title:      "No static service-account keys",
		Severity:   SeverityHigh,
		Provider:   "gcp",
		Frameworks: []string{"CIS-GCP-1.4", "SOC2-CC6.1"},
		Status:     StatusPass,
	}
	for _, r := range planned {
		if r.rtype == "google_service_account_key" {
			c.Findings = append(c.Findings, Finding{
				Address: r.address,
				Message: "creates a long-lived service-account key; use Workload Identity Federation instead",
			})
		}
	}
	if len(c.Findings) > 0 {
		c.Status = StatusFail
	}
	return c
}

// controlGCPWorkloadIdentity — GCP-WIF-001. A workload-identity-pool provider must
// carry an `attribute_condition` (the GCP analogue of binding the `sub` claim): a
// provider with no condition lets any external identity from the issuer federate.
func controlGCPWorkloadIdentity(planned []plannedResource) ControlResult {
	c := ControlResult{
		ID:         "GCP-WIF-001",
		Title:      "Workload-identity providers are attribute-conditioned",
		Severity:   SeverityHigh,
		Provider:   "gcp",
		Frameworks: []string{"SOC2-CC6.1"},
	}
	relevant, evaluable, notEval := 0, 0, 0
	var coverage []string

	for _, r := range planned {
		if r.rtype != "google_iam_workload_identity_pool_provider" {
			continue
		}
		relevant++
		if attrUnknown(r.afterUnknown, "attribute_condition") {
			notEval++
			coverage = append(coverage, r.address+": attribute_condition not known until apply")
			continue
		}
		evaluable++
		cond := strings.TrimSpace(asString(r.after["attribute_condition"]))
		if cond == "" {
			c.Findings = append(c.Findings, Finding{
				Address: r.address,
				Message: "workload-identity provider has no attribute_condition — any identity from the issuer can federate; constrain it (e.g. on assertion.repository / aud)",
			})
		}
	}
	resolveStatus(&c, len(c.Findings), 0, evaluable, relevant, notEval, coverage)
	return c
}

// controlGCPLeastPrivilege — GCP-LEASTPRIV-001. Binding the project-wide primitive
// roles is over-broad: `roles/owner` is a hard fail, `roles/editor` a warning.
func controlGCPLeastPrivilege(planned []plannedResource) ControlResult {
	c := ControlResult{
		ID:         "GCP-LEASTPRIV-001",
		Title:      "No project-wide primitive roles",
		Severity:   SeverityHigh,
		Provider:   "gcp",
		Frameworks: []string{"CIS-GCP-1.5", "SOC2-CC6.3"},
	}
	iamTypes := map[string]bool{
		"google_project_iam_member": true, "google_project_iam_binding": true,
	}
	failed, warned, relevant, evaluable, notEval := 0, 0, 0, 0, 0
	var coverage []string

	for _, r := range planned {
		if !iamTypes[r.rtype] {
			continue
		}
		relevant++
		if attrUnknown(r.afterUnknown, "role") {
			notEval++
			coverage = append(coverage, r.address+": role not known until apply")
			continue
		}
		evaluable++
		role := asString(r.after["role"])
		switch role {
		case "roles/owner":
			c.Findings = append(c.Findings, Finding{Address: r.address, Message: "binds roles/owner at the project level (full administrative access)"})
			failed++
		case "roles/editor":
			c.Findings = append(c.Findings, Finding{Address: r.address, Message: "binds roles/editor at the project level (broad write access)"})
			warned++
		}
	}
	resolveStatus(&c, failed, warned, evaluable, relevant, notEval, coverage)
	return c
}
