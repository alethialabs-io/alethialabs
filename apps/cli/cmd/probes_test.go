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

func bptr(v bool) *bool { return &v }

func TestRunProbesList(t *testing.T) {
	up, down := true, false
	ts := "2026-01-01T00:00:00.000Z"
	c := &fakeClient{probes: []api.ProbeState{
		{Environment: "production", Reachable: &up, ProbedAt: &ts},
		{Environment: "staging", Reachable: &down, Message: strptr("dial tcp: timeout"), ProbedAt: &ts},
		{Environment: "dev", Reachable: nil},
	}}
	var buf bytes.Buffer
	if err := runProbesList(c, &buf, "table", "proj"); err != nil {
		t.Fatalf("runProbesList: %v", err)
	}
	out := buf.String()
	for _, want := range []string{"production", "up", "staging", "down", "dial tcp: timeout", "dev", "never probed"} {
		if !strings.Contains(out, want) {
			t.Errorf("table output missing %q:\n%s", want, out)
		}
	}
}

func TestRunProbesListJSON(t *testing.T) {
	c := &fakeClient{probes: []api.ProbeState{{Environment: "production", Reachable: bptr(true)}}}
	var buf bytes.Buffer
	if err := runProbesList(c, &buf, "json", "proj"); err != nil {
		t.Fatalf("runProbesList json: %v", err)
	}
	if !strings.Contains(buf.String(), `"reachable": true`) {
		t.Errorf("json output unexpected:\n%s", buf.String())
	}
}

func TestRunProbesListEmpty(t *testing.T) {
	c := &fakeClient{probes: nil}
	var buf bytes.Buffer
	if err := runProbesList(c, &buf, "table", "proj"); err != nil {
		t.Fatalf("runProbesList empty: %v", err)
	}
	if !strings.Contains(buf.String(), "No environments found") {
		t.Errorf("expected empty notice, got: %q", buf.String())
	}
}

func TestRunProbesListError(t *testing.T) {
	c := &fakeClient{err: errors.New("boom")}
	if err := runProbesList(c, &bytes.Buffer{}, "table", "proj"); err == nil {
		t.Error("expected error to propagate")
	}
}

// reachableLabel renders true/false/nil as up/down/never-probed.
func TestReachableLabel(t *testing.T) {
	if !strings.Contains(reachableLabel(bptr(true)), "up") {
		t.Error("expected up")
	}
	if !strings.Contains(reachableLabel(bptr(false)), "down") {
		t.Error("expected down")
	}
	if !strings.Contains(reachableLabel(nil), "never probed") {
		t.Error("expected never probed")
	}
}
