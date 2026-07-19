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

func TestRunDriftShowDrifted(t *testing.T) {
	ts := "2026-01-01T00:00:00.000Z"
	c := &fakeClient{drift: &api.DriftPosture{
		Evaluated: true, InSync: false, Drifted: 2, ScannedAt: &ts, Environment: strptr("production"),
		Details: []api.DriftDetail{
			{Address: "aws_db_instance.main", Type: "aws_db_instance", Kind: "modified"},
			{Address: "aws_s3_bucket.logs", Type: "aws_s3_bucket", Kind: "deleted"},
		},
	}}
	var buf bytes.Buffer
	if err := runDriftShow(c, &buf, "table", "proj", ""); err != nil {
		t.Fatalf("runDriftShow: %v", err)
	}
	out := buf.String()
	for _, want := range []string{"2 resource(s) drifted", "production", "aws_db_instance.main", "modified", "aws_s3_bucket.logs"} {
		if !strings.Contains(out, want) {
			t.Errorf("table output missing %q:\n%s", want, out)
		}
	}
}

func TestRunDriftShowInSync(t *testing.T) {
	ts := "2026-01-01T00:00:00.000Z"
	c := &fakeClient{drift: &api.DriftPosture{Evaluated: true, InSync: true, Drifted: 0, ScannedAt: &ts}}
	var buf bytes.Buffer
	if err := runDriftShow(c, &buf, "table", "proj", ""); err != nil {
		t.Fatalf("runDriftShow: %v", err)
	}
	if !strings.Contains(buf.String(), "in sync") {
		t.Errorf("expected in-sync summary, got: %q", buf.String())
	}
}

func TestRunDriftShowNotEvaluated(t *testing.T) {
	c := &fakeClient{drift: &api.DriftPosture{Evaluated: false}}
	var buf bytes.Buffer
	if err := runDriftShow(c, &buf, "table", "proj", ""); err != nil {
		t.Fatalf("runDriftShow: %v", err)
	}
	if !strings.Contains(buf.String(), "not evaluated") {
		t.Errorf("expected not-evaluated summary, got: %q", buf.String())
	}
}

func TestRunDriftShowJSON(t *testing.T) {
	c := &fakeClient{drift: &api.DriftPosture{Evaluated: true, InSync: false, Drifted: 1, Details: []api.DriftDetail{{Address: "a", Type: "t", Kind: "modified"}}}}
	var buf bytes.Buffer
	if err := runDriftShow(c, &buf, "json", "proj", ""); err != nil {
		t.Fatalf("runDriftShow json: %v", err)
	}
	if !strings.Contains(buf.String(), `"evaluated": true`) || !strings.Contains(buf.String(), `"kind": "modified"`) {
		t.Errorf("json output unexpected:\n%s", buf.String())
	}
}

func TestRunDriftShowError(t *testing.T) {
	c := &fakeClient{err: errors.New("boom")}
	if err := runDriftShow(c, &bytes.Buffer{}, "table", "proj", ""); err == nil {
		t.Error("expected error to propagate")
	}
}
