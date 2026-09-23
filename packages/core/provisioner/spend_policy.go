// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"fmt"
	"slices"
	"sort"
	"strings"

	tfjson "github.com/hashicorp/terraform-json"
)

// SpendPolicy is the pre-apply spend control for clouds a monthly-USD cost ceiling cannot guard
// (#2385). Infracost prices AWS, Azure and Google only, so on hetzner and alibaba
// costCeilingBlock has no estimate to compare against, and a ceiling set there would only
// fail-close every apply. What CAN be checked on those clouds is the SHAPE of the plan, before
// anything is bought:
//
//   - HcloudServerTypes caps the Hetzner node shape. Every `hcloud_server` that the plan creates
//     or updates must name one of these server types. Hetzner type names do not sort by price
//     (cpx22, cx33 and ccx13 are three product lines), so the cap is written as an ALLOWLIST: a
//     type that is not listed is refused, and an unknown value is refused too.
//   - RefusePrepaid refuses every `alicloud_*` resource that the plan creates or updates with a
//     prepaid billing mode (`payment_type = "Subscription"` or `instance_charge_type = "PrePaid"`).
//     A monthly-USD ceiling cannot see a prepaid resource at all: the money goes at purchase, and
//     a teardown does not reliably return it (see modules/cr/main.tf, #2333).
//
// The zero value disables both checks. That is the default, so a real customer apply is never
// affected. The e2e workflow opts in per cloud through ALETHIA_SPEND_HCLOUD_SERVER_TYPES and
// ALETHIA_SPEND_REFUSE_PREPAID, and scripts/check-e2e-spend-guard.mjs fails CI when a cloud in
// the scheduled matrix has neither this control nor a cost ceiling.
type SpendPolicy struct {
	// HcloudServerTypes is the allowlist of Hetzner server types. Empty disables the check.
	HcloudServerTypes []string `json:"hcloud_server_types,omitempty"`
	// RefusePrepaid refuses prepaid Alibaba resources. False disables the check.
	RefusePrepaid bool `json:"refuse_prepaid,omitempty"`
}

// Enabled reports whether any check in the policy is switched on.
func (p SpendPolicy) Enabled() bool {
	return len(p.HcloudServerTypes) > 0 || p.RefusePrepaid
}

// prepaidBilling lists, per billing attribute, the values that mean "paid up front". Matched
// case-insensitively: the provider documents `Subscription` and `PrePaid`, and a wrong-case
// value is still the same purchase.
var prepaidBilling = map[string][]string{
	"payment_type":         {"subscription", "prepaid"},
	"instance_charge_type": {"prepaid", "subscription"},
}

// spendPolicyBlock decides whether a real apply must be refused under the policy. It returns
// (blocked, message). It is pure, so every red path is table-tested offline.
//
// It FAIL-CLOSES when the policy is on but the plan JSON is missing: a control that could not
// read the plan has not checked anything, so it must not read as a pass.
//
// Only changes that CREATE or UPDATE a resource are read. A delete or a no-op on something that
// already exists does not buy anything new, and refusing it would stop a teardown or a re-apply
// from cleaning up the thing the policy is there to prevent.
func spendPolicyBlock(plan *tfjson.Plan, p SpendPolicy) (bool, string) {
	if !p.Enabled() {
		return false, ""
	}
	if plan == nil {
		return true, "spend policy BLOCKED apply: a pre-apply spend policy is set but the plan JSON could not be read — refusing to apply a plan that was not checked"
	}

	var findings []string
	for _, rc := range plan.ResourceChanges {
		if rc == nil || rc.Change == nil || !buysSomething(rc.Change.Actions) {
			continue
		}
		after, _ := rc.Change.After.(map[string]any)
		unknown, _ := rc.Change.AfterUnknown.(map[string]any)

		if len(p.HcloudServerTypes) > 0 && rc.Type == "hcloud_server" {
			if f := hcloudServerTypeFinding(rc.Address, after, unknown, p.HcloudServerTypes); f != "" {
				findings = append(findings, f)
			}
		}
		if p.RefusePrepaid && strings.HasPrefix(rc.Type, "alicloud_") {
			findings = append(findings, prepaidFindings(rc.Address, after)...)
		}
	}
	if len(findings) == 0 {
		return false, ""
	}
	sort.Strings(findings)
	return true, "spend policy BLOCKED apply: " + strings.Join(findings, "; ")
}

// buysSomething reports whether a change's actions create or update a resource.
func buysSomething(actions tfjson.Actions) bool {
	return actions.Create() || actions.Update() || actions.Replace()
}

// hcloudServerTypeFinding returns a refusal message when one hcloud_server's type is outside the
// allowlist, or cannot be read. It returns "" when the type is allowed.
func hcloudServerTypeFinding(address string, after, unknown map[string]any, allowed []string) string {
	if isUnknown, _ := unknown["server_type"].(bool); isUnknown {
		return fmt.Sprintf("%s has a server_type that is not known until apply, so it cannot be checked against the cap %v", address, allowed)
	}
	got, _ := after["server_type"].(string)
	if got == "" {
		return fmt.Sprintf("%s has no readable server_type, so it cannot be checked against the cap %v", address, allowed)
	}
	if slices.Contains(allowed, strings.ToLower(strings.TrimSpace(got))) {
		return ""
	}
	return fmt.Sprintf("%s uses server type %q, which is outside the cap %v (ALETHIA_SPEND_HCLOUD_SERVER_TYPES)", address, got, allowed)
}

// prepaidFindings returns one refusal message for each prepaid billing attribute on a resource.
func prepaidFindings(address string, after map[string]any) []string {
	var out []string
	for attr, values := range prepaidBilling {
		got, _ := after[attr].(string)
		if got != "" && slices.Contains(values, strings.ToLower(strings.TrimSpace(got))) {
			out = append(out, fmt.Sprintf("%s sets %s = %q, a prepaid purchase that a teardown does not refund (ALETHIA_SPEND_REFUSE_PREPAID)", address, attr, got))
		}
	}
	return out
}
