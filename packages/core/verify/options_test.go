// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package verify

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// fakeChecker is a deterministic PolicyChecker for tests: it reports a denied
// action as grantable iff the policy JSON literally contains it (or "*").
type fakeChecker struct {
	err error
}

func (f fakeChecker) CheckAccessNotGranted(_ context.Context, policyJSON string, denied []string) ([]string, error) {
	if f.err != nil {
		return nil, f.err
	}
	var granted []string
	for _, a := range denied {
		if strings.Contains(policyJSON, a) || strings.Contains(policyJSON, `"*"`) {
			granted = append(granted, a)
		}
	}
	return granted, nil
}

func TestAccessAnalyzerDisabledByDefault(t *testing.T) {
	rep := evalFixture(t, "pass_keyless_least_priv.json")
	for _, c := range rep.Controls {
		if c.ID == "ACCESS-ANALYZER-001" {
			t.Fatal("Access Analyzer control must not run without a PolicyChecker")
		}
	}
}

func TestAccessAnalyzerFlagsSensitiveGrant(t *testing.T) {
	plan := mustPlan(t, `{
      "format_version": "1.2",
      "resource_changes": [
        {"address":"aws_iam_policy.danger","mode":"managed","type":"aws_iam_policy","name":"danger",
         "change":{"actions":["create"],"after":{"name":"danger","policy":"{\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"kms:Decrypt\",\"Resource\":\"*\"}]}"},"after_unknown":{}}}
      ]}`)
	rep, err := EvaluateWithOptions(context.Background(), plan, Options{
		PolicyChecker: fakeChecker{},
		DeniedActions: []string{"kms:Decrypt"},
	})
	if err != nil {
		t.Fatal(err)
	}
	c := controlByID(t, rep, "ACCESS-ANALYZER-001")
	if c.Status != StatusFail {
		t.Fatalf("ACCESS-ANALYZER-001 = %q, want fail (kms:Decrypt grantable)", c.Status)
	}
	if rep.Verdict != StatusFail {
		t.Errorf("overall verdict = %q, want fail", rep.Verdict)
	}
}

func TestAccessAnalyzerPassesCleanPolicy(t *testing.T) {
	plan := mustPlan(t, `{
      "format_version": "1.2",
      "resource_changes": [
        {"address":"aws_iam_policy.ok","mode":"managed","type":"aws_iam_policy","name":"ok",
         "change":{"actions":["create"],"after":{"name":"ok","policy":"{\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"s3:GetObject\",\"Resource\":\"arn:aws:s3:::b/*\"}]}"},"after_unknown":{}}}
      ]}`)
	rep, err := EvaluateWithOptions(context.Background(), plan, Options{PolicyChecker: fakeChecker{}})
	if err != nil {
		t.Fatal(err)
	}
	c := controlByID(t, rep, "ACCESS-ANALYZER-001")
	if c.Status != StatusPass {
		t.Fatalf("ACCESS-ANALYZER-001 = %q, want pass for a scoped policy", c.Status)
	}
}

func TestAccessAnalyzerErrorIsNotEvaluable(t *testing.T) {
	plan := mustPlan(t, `{
      "format_version": "1.2",
      "resource_changes": [
        {"address":"aws_iam_policy.x","mode":"managed","type":"aws_iam_policy","name":"x",
         "change":{"actions":["create"],"after":{"name":"x","policy":"{\"Statement\":[]}"},"after_unknown":{}}}
      ]}`)
	rep, err := EvaluateWithOptions(context.Background(), plan, Options{
		PolicyChecker: fakeChecker{err: errors.New("api throttled")},
	})
	if err != nil {
		t.Fatal(err)
	}
	c := controlByID(t, rep, "ACCESS-ANALYZER-001")
	if c.Status != StatusNotEvaluable {
		t.Fatalf("a checker error must yield not_evaluable, got %q", c.Status)
	}
	if c.Coverage == "" {
		t.Error("not_evaluable control should explain the coverage gap")
	}
}

func TestEvaluateWithOptionsZeroValueEqualsEvaluate(t *testing.T) {
	plan := loadPlan(t, "fail_static_key_admin.json")
	a, _ := Evaluate(context.Background(), plan)
	b, _ := EvaluateWithOptions(context.Background(), plan, Options{})
	if a.Verdict != b.Verdict || len(a.Controls) != len(b.Controls) {
		t.Errorf("zero-Options must equal Evaluate: %d/%s vs %d/%s",
			len(a.Controls), a.Verdict, len(b.Controls), b.Verdict)
	}
}
