// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"errors"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

func f64(v float64) *float64 { return &v }

func TestRunCostShowPriced(t *testing.T) {
	ts := "2026-01-01T00:00:00.000Z"
	c := &fakeClient{cost: &api.EnvironmentCost{
		Priced: true, TotalMonthly: f64(123.45), Currency: "USD", CapturedAt: &ts, Environment: strptr("staging"),
		Resources: []api.CostResourceLine{
			{Address: "aws_db_instance.main", ResourceType: "aws_db_instance", MonthlyCost: 100.00},
			{Address: "aws_s3_bucket.logs", ResourceType: "aws_s3_bucket", MonthlyCost: 23.45},
		},
	}}
	var buf bytes.Buffer
	if err := runCostShow(c, &buf, "table", "proj", "staging"); err != nil {
		t.Fatalf("runCostShow: %v", err)
	}
	out := buf.String()
	for _, want := range []string{"$123.45/mo", "USD", "staging", "aws_db_instance.main", "$100.00"} {
		if !strings.Contains(out, want) {
			t.Errorf("table output missing %q:\n%s", want, out)
		}
	}
}

func TestRunCostShowUnpriced(t *testing.T) {
	c := &fakeClient{cost: &api.EnvironmentCost{Priced: false, Currency: "USD"}}
	var buf bytes.Buffer
	if err := runCostShow(c, &buf, "table", "proj", ""); err != nil {
		t.Fatalf("runCostShow: %v", err)
	}
	if !strings.Contains(buf.String(), "not priced") {
		t.Errorf("expected not-priced summary, got: %q", buf.String())
	}
}

func TestRunCostShowJSON(t *testing.T) {
	c := &fakeClient{cost: &api.EnvironmentCost{Priced: true, TotalMonthly: f64(10), Currency: "USD", Resources: []api.CostResourceLine{{Address: "a", ResourceType: "t", MonthlyCost: 10}}}}
	var buf bytes.Buffer
	if err := runCostShow(c, &buf, "json", "proj", ""); err != nil {
		t.Fatalf("runCostShow json: %v", err)
	}
	if !strings.Contains(buf.String(), `"priced": true`) || !strings.Contains(buf.String(), `"resource_type": "t"`) {
		t.Errorf("json output unexpected:\n%s", buf.String())
	}
}

func TestRunCostShowError(t *testing.T) {
	c := &fakeClient{err: errors.New("boom")}
	if err := runCostShow(c, &bytes.Buffer{}, "table", "proj", ""); err == nil {
		t.Error("expected error to propagate")
	}
}
