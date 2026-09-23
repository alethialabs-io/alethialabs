// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"encoding/json"
	"slices"
	"testing"
)

// TestSpendPolicyFromEnv pins the parse of the opt-in pre-apply spend policy (#2385). The env
// names are the ones .github/workflows/e2e-nightly.yml sets and scripts/check-e2e-spend-guard.mjs
// checks for, so a rename here must fail a test rather than silently disarm the control.
func TestSpendPolicyFromEnv(t *testing.T) {
	t.Run("unset is the zero policy", func(t *testing.T) {
		t.Setenv("ALETHIA_SPEND_HCLOUD_SERVER_TYPES", "")
		t.Setenv("ALETHIA_SPEND_REFUSE_PREPAID", "")
		if p := spendPolicyFromEnv(); p.Enabled() {
			t.Fatalf("empty env must disable the policy, got %+v", p)
		}
	})

	t.Run("server types are trimmed, lower-cased and empties dropped", func(t *testing.T) {
		t.Setenv("ALETHIA_SPEND_HCLOUD_SERVER_TYPES", " CPX22, cpx32 ,,cx33,")
		t.Setenv("ALETHIA_SPEND_REFUSE_PREPAID", "")
		got := spendPolicyFromEnv().HcloudServerTypes
		if want := []string{"cpx22", "cpx32", "cx33"}; !slices.Equal(got, want) {
			t.Fatalf("HcloudServerTypes = %v, want %v", got, want)
		}
	})

	t.Run("only a comma list is still no cap", func(t *testing.T) {
		t.Setenv("ALETHIA_SPEND_HCLOUD_SERVER_TYPES", " , ,")
		if got := spendPolicyFromEnv().HcloudServerTypes; len(got) != 0 {
			t.Fatalf("HcloudServerTypes = %v, want none", got)
		}
	})

	for raw, want := range map[string]bool{
		"1": true, "true": true, " YES ": true, "on": true,
		"": false, "0": false, "false": false, "off": false, "garbage": false,
	} {
		t.Run("refuse prepaid "+raw, func(t *testing.T) {
			t.Setenv("ALETHIA_SPEND_HCLOUD_SERVER_TYPES", "")
			t.Setenv("ALETHIA_SPEND_REFUSE_PREPAID", raw)
			if got := spendPolicyFromEnv().RefusePrepaid; got != want {
				t.Fatalf("RefusePrepaid(%q) = %v, want %v", raw, got, want)
			}
		})
	}
}

// TestSpendPolicySurvivesThePayload proves the policy crosses the sandbox boundary: the container
// child sees no env, so a field dropped from the JSON payload would disarm the control there.
func TestSpendPolicySurvivesThePayload(t *testing.T) {
	var in stageDeployPayload
	in.SpendPolicy.HcloudServerTypes = []string{"cpx22"}
	in.SpendPolicy.RefusePrepaid = true
	raw, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	var out stageDeployPayload
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	if !out.SpendPolicy.RefusePrepaid || !slices.Equal(out.SpendPolicy.HcloudServerTypes, []string{"cpx22"}) {
		t.Fatalf("policy lost in the payload round-trip: %s", raw)
	}
}
