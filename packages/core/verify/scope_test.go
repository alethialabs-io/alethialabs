// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package verify

import (
	"context"
	"strings"
	"testing"
)

// evalCorpus loads + evaluates a labeled corpus fixture (testdata/corpus), which is
// where the scope fixtures live (evalFixture reads the flat testdata/ dir).
func evalCorpus(t *testing.T, name string) *Report {
	t.Helper()
	rep, err := Evaluate(context.Background(), loadBasePlan(t, name))
	if err != nil {
		t.Fatalf("Evaluate(%s): %v", name, err)
	}
	return rep
}

// TestUnknownProviderIsNotEvaluable is the headline for the fail-closed scope gap: a
// plan whose providers are ALL unrecognized (a typo'd/custom provider, or AWS Cloud
// Control `awscc_`) must be not_evaluable, never a vacuous PASS. The non-vacuity
// half proves the fix is load-bearing: the SAME plan run through the pre-fix path
// (detectProviders → selectControls → finalize, WITHOUT the SCOPE-001 backstop) is a
// PASS. So the flip to not_evaluable is caused solely by the backstop.
func TestUnknownProviderIsNotEvaluable(t *testing.T) {
	rep := evalCorpus(t, "all_unknown_provider.json")
	if rep.Verdict != StatusNotEvaluable {
		t.Fatalf("all-unknown-provider plan: verdict = %q, want not_evaluable — a plan the gate can't reason about must not PASS", rep.Verdict)
	}
	scope := controlByID(t, rep, "SCOPE-001")
	if scope.Status != StatusNotEvaluable {
		t.Errorf("SCOPE-001 = %q, want not_evaluable", scope.Status)
	}
	if len(scope.Findings) != 2 {
		t.Errorf("SCOPE-001 findings = %d, want 2 (one per unrecognized resource)", len(scope.Findings))
	}

	// Non-vacuity: reconstruct the PRE-FIX verdict (no SCOPE-001) over the identical
	// plan. It must be pass — proving the vacuous-PASS hole was real and that SCOPE-001
	// is exactly what closes it.
	planned := gatherPlanned(loadBasePlan(t, "all_unknown_provider.json"))
	pre := &Report{CatalogVersion: CatalogVersion}
	pre.Controls = selectControls(detectProviders(planned), planned)
	pre.finalize()
	if pre.Verdict != StatusPass {
		t.Fatalf("pre-fix (no SCOPE-001) verdict = %q, want pass — the fixture must demonstrate the vacuous-PASS hole it closes", pre.Verdict)
	}
}

// TestAwsccCloudControlIsCaught pins the concrete motivating case: an `awscc_`
// (AWS Cloud Control) resource is NOT matched by the `aws_` controls, so an
// awscc-only plan is unrecognized and must be not_evaluable, and the finding must
// name the awscc provider token.
func TestAwsccCloudControlIsCaught(t *testing.T) {
	rep, err := Evaluate(t.Context(), mustPlan(t, `{
      "format_version": "1.2",
      "resource_changes": [
        {"address":"awscc_s3_bucket.b","mode":"managed","type":"awscc_s3_bucket","name":"b",
         "provider_name":"registry.terraform.io/hashicorp/awscc",
         "change":{"actions":["create"],"after":{"bucket_name":"x"},"after_unknown":{}}}
      ]}`))
	if err != nil {
		t.Fatal(err)
	}
	if rep.Verdict != StatusNotEvaluable {
		t.Fatalf("awscc-only plan: verdict = %q, want not_evaluable", rep.Verdict)
	}
	scope := controlByID(t, rep, "SCOPE-001")
	if len(scope.Findings) != 1 || !strings.Contains(scope.Findings[0].Message, `"awscc"`) {
		t.Errorf("SCOPE-001 findings = %+v, want one naming the awscc provider", scope.Findings)
	}
}

// TestSupportedNoControlProvidersPass proves the allowlist prevents a false-DENY on
// legitimate supported clouds: a Hetzner + utility-only plan (no keyless/OIDC/least-
// priv surface by design) is a legitimate vacuous PASS, and SCOPE-001 must NOT fire.
func TestSupportedNoControlProvidersPass(t *testing.T) {
	rep := evalCorpus(t, "hetzner_utility_pass.json")
	if rep.Verdict != StatusPass {
		t.Fatalf("hetzner+utility plan: verdict = %q, want pass (supported-no-controls must not be denied)", rep.Verdict)
	}
	for _, c := range rep.Controls {
		if c.ID == "SCOPE-001" {
			t.Errorf("SCOPE-001 must not be present on an all-supported plan (fired on a legit cloud): %+v", c)
		}
	}
}

// TestMixedAwsUnknownIsNotEvaluable is the mixed-plan case: aws (clean) + an
// unrecognized provider. The aws controls must still run (the gate reasons about
// what it can), but the unknown resource means the gate can't fully reason → the
// overall verdict is not_evaluable (fail-closed), not pass.
func TestMixedAwsUnknownIsNotEvaluable(t *testing.T) {
	rep := evalCorpus(t, "aws_unknown_mixed.json")
	if rep.Verdict != StatusNotEvaluable {
		t.Fatalf("aws(clean)+unknown plan: verdict = %q, want not_evaluable", rep.Verdict)
	}
	// The AWS control set still ran (it reasons about what it can see).
	if !hasControl(rep, "KEYLESS-001") {
		t.Error("AWS controls did not run on a mixed aws+unknown plan")
	}
	// And SCOPE-001 flagged only the unknown resource, not the aws one.
	scope := controlByID(t, rep, "SCOPE-001")
	if len(scope.Findings) != 1 || !strings.HasPrefix(scope.Findings[0].Address, "awscc_") {
		t.Errorf("SCOPE-001 findings = %+v, want exactly the awscc resource", scope.Findings)
	}
}

// TestMixedAwsViolationPlusUnknownStillFails proves fail precedence: when the AWS
// half has a real violation AND there is an unknown provider, the hard fail wins
// (blocks the apply) — the unknown provider does not soften a violation to
// not_evaluable.
func TestMixedAwsViolationPlusUnknownStillFails(t *testing.T) {
	rep, err := Evaluate(t.Context(), mustPlan(t, `{
      "format_version": "1.2",
      "resource_changes": [
        {"address":"aws_iam_access_key.leaked","mode":"managed","type":"aws_iam_access_key","name":"leaked",
         "provider_name":"registry.terraform.io/hashicorp/aws",
         "change":{"actions":["create"],"after":{"user":"ci"},"after_unknown":{"secret":true}}},
        {"address":"awscc_s3_bucket.b","mode":"managed","type":"awscc_s3_bucket","name":"b",
         "provider_name":"registry.terraform.io/hashicorp/awscc",
         "change":{"actions":["create"],"after":{"bucket_name":"x"},"after_unknown":{}}}
      ]}`))
	if err != nil {
		t.Fatal(err)
	}
	if rep.Verdict != StatusFail || !rep.Blocking() {
		t.Fatalf("aws(static-key)+unknown: verdict = %q blocking=%v, want fail/blocking (a real violation must still block)", rep.Verdict, rep.Blocking())
	}
	if controlByID(t, rep, "KEYLESS-001").Status != StatusFail {
		t.Error("KEYLESS-001 should fail on the static access key regardless of the unknown provider")
	}
}

// TestScopeBackstopDeterministic asserts the backstop keeps Evaluate deterministic:
// the same plan yields byte-identical control lists (order + findings) across runs —
// the property the signed receipt relies on.
func TestScopeBackstopDeterministic(t *testing.T) {
	a := evalCorpus(t, "all_unknown_provider.json")
	b := evalCorpus(t, "all_unknown_provider.json")
	if len(a.Controls) != len(b.Controls) || a.Verdict != b.Verdict {
		t.Fatalf("non-deterministic: a=(%d,%s) b=(%d,%s)", len(a.Controls), a.Verdict, len(b.Controls), b.Verdict)
	}
	as := controlByID(t, a, "SCOPE-001")
	bs := controlByID(t, b, "SCOPE-001")
	if len(as.Findings) != len(bs.Findings) {
		t.Fatalf("SCOPE-001 finding count differs across runs: %d vs %d", len(as.Findings), len(bs.Findings))
	}
	for i := range as.Findings {
		if as.Findings[i] != bs.Findings[i] {
			t.Errorf("SCOPE-001 finding %d differs across runs (non-deterministic order): %+v vs %+v", i, as.Findings[i], bs.Findings[i])
		}
	}
}

// TestProviderToken pins the prefix extraction that buckets each resource.
func TestProviderToken(t *testing.T) {
	cases := map[string]string{
		"aws_iam_role":              "aws",
		"google_project_iam_member": "google",
		"azurerm_role_assignment":   "azurerm",
		"azuread_application":       "azuread",
		"hcloud_server":             "hcloud",
		"awscc_s3_bucket":           "awscc",
		"random_id":                 "random",
		"external":                  "external",
	}
	for rtype, want := range cases {
		if got := providerToken(rtype); got != want {
			t.Errorf("providerToken(%q) = %q, want %q", rtype, got, want)
		}
	}
}
