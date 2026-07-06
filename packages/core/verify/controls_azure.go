// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package verify

import "strings"

// azureControls mirrors the AWS/GCP control sets for Azure: no static
// application/service-principal secrets, federated credentials must bind a
// subject, and no Owner/Contributor role assignments at broad scope.
func azureControls(planned []plannedResource) []ControlResult {
	return []ControlResult{
		controlAzureNoStaticSecrets(planned),
		controlAzureFederatedSubject(planned),
		controlAzureLeastPrivilege(planned),
	}
}

// controlAzureNoStaticSecrets — AZURE-KEYLESS-001. An application or service-
// principal password is a long-lived client secret; prefer federated identity
// credentials (OIDC) instead.
func controlAzureNoStaticSecrets(planned []plannedResource) ControlResult {
	c := ControlResult{
		ID:         "AZURE-KEYLESS-001",
		Title:      "No static application/service-principal secrets",
		Severity:   SeverityHigh,
		Provider:   "azure",
		Frameworks: []string{"SOC2-CC6.1"},
		Status:     StatusPass,
	}
	secretTypes := map[string]bool{
		"azuread_application_password":       true,
		"azuread_service_principal_password": true,
	}
	for _, r := range planned {
		if secretTypes[r.rtype] {
			c.Findings = append(c.Findings, Finding{
				Address: r.address,
				Message: "creates a long-lived client secret; use an azuread_application_federated_identity_credential (OIDC) instead",
			})
		}
	}
	if len(c.Findings) > 0 {
		c.Status = StatusFail
	}
	return c
}

// controlAzureFederatedSubject — AZURE-FED-001. A federated identity credential
// must bind a concrete `subject` (and not a bare wildcard) — the Azure analogue of
// the OIDC `sub` binding.
func controlAzureFederatedSubject(planned []plannedResource) ControlResult {
	c := ControlResult{
		ID:         "AZURE-FED-001",
		Title:      "Federated credentials bind a specific subject",
		Severity:   SeverityHigh,
		Provider:   "azure",
		Frameworks: []string{"SOC2-CC6.1"},
	}
	relevant, evaluable, notEval := 0, 0, 0
	var coverage []string

	for _, r := range planned {
		if r.rtype != "azuread_application_federated_identity_credential" {
			continue
		}
		relevant++
		if attrUnknown(r.afterUnknown, "subject") {
			notEval++
			coverage = append(coverage, r.address+": subject not known until apply")
			continue
		}
		evaluable++
		subject := strings.TrimSpace(asString(r.after["subject"]))
		switch {
		case subject == "":
			c.Findings = append(c.Findings, Finding{Address: r.address, Message: "federated credential has no subject — any token from the issuer can assume this identity"})
		case strings.Contains(subject, "*"):
			c.Findings = append(c.Findings, Finding{Address: r.address, Message: "federated credential subject contains a wildcard (" + subject + ") — pin the exact subject"})
		}
	}
	resolveStatus(&c, len(c.Findings), 0, evaluable, relevant, notEval, coverage)
	return c
}

// controlAzureLeastPrivilege — AZURE-LEASTPRIV-001. An Owner role assignment is a
// hard fail; Contributor is a warning. Broad scope (subscription/management-group)
// raises the concern further but Owner is flagged regardless of scope.
func controlAzureLeastPrivilege(planned []plannedResource) ControlResult {
	c := ControlResult{
		ID:         "AZURE-LEASTPRIV-001",
		Title:      "No Owner/Contributor role assignments",
		Severity:   SeverityHigh,
		Provider:   "azure",
		Frameworks: []string{"SOC2-CC6.3"},
	}
	failed, warned, relevant, evaluable, notEval := 0, 0, 0, 0, 0
	var coverage []string

	for _, r := range planned {
		if r.rtype != "azurerm_role_assignment" {
			continue
		}
		relevant++
		// The role can be given by name or by a definition id; only the name is
		// judgeable here.
		if attrUnknown(r.afterUnknown, "role_definition_name") {
			notEval++
			coverage = append(coverage, r.address+": role_definition_name not known until apply")
			continue
		}
		role := asString(r.after["role_definition_name"])
		if role == "" {
			// Assigned by role_definition_id (a GUID) — body/role name not in plan.
			notEval++
			coverage = append(coverage, r.address+": assigned by role_definition_id (role name not in plan)")
			continue
		}
		evaluable++
		scope := asString(r.after["scope"])
		switch role {
		case "Owner":
			c.Findings = append(c.Findings, Finding{Address: r.address, Message: "assigns the Owner role" + scopeSuffix(scope)})
			failed++
		case "Contributor":
			c.Findings = append(c.Findings, Finding{Address: r.address, Message: "assigns the Contributor role" + scopeSuffix(scope)})
			warned++
		}
	}
	resolveStatus(&c, failed, warned, evaluable, relevant, notEval, coverage)
	return c
}

// scopeSuffix annotates a finding when the assignment is at subscription or
// management-group scope (broadest blast radius).
func scopeSuffix(scope string) string {
	s := strings.ToLower(scope)
	switch {
	case strings.HasPrefix(s, "/providers/microsoft.management/managementgroups"):
		return " at management-group scope (very broad)"
	case strings.HasPrefix(s, "/subscriptions/") && !strings.Contains(s, "/resourcegroups/"):
		return " at subscription scope (broad)"
	default:
		return ""
	}
}
