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

func TestRunIacShow(t *testing.T) {
	sha := "abc1234"
	c := &fakeClient{iacSource: &api.IacSource{
		ID: "src-1", Environment: "production", Name: "networking", RepoURL: "https://github.com/acme/infra",
		Path: "envs/prod", Enabled: true, ScanStatus: "done", CommitSha: &sha, Status: "READY",
	}}
	var buf bytes.Buffer
	if err := runIacShow(c, &buf, "table", "proj", ""); err != nil {
		t.Fatalf("runIacShow: %v", err)
	}
	out := buf.String()
	for _, want := range []string{"networking", "acme/infra", "envs/prod", "done", "abc1234", "READY"} {
		if !strings.Contains(out, want) {
			t.Errorf("table output missing %q:\n%s", want, out)
		}
	}
}

func TestRunIacShowJSON(t *testing.T) {
	c := &fakeClient{iacSource: &api.IacSource{ID: "src-1", Name: "networking", Status: "READY"}}
	var buf bytes.Buffer
	if err := runIacShow(c, &buf, "json", "proj", ""); err != nil {
		t.Fatalf("runIacShow json: %v", err)
	}
	if !strings.Contains(buf.String(), `"name": "networking"`) {
		t.Errorf("json output unexpected:\n%s", buf.String())
	}
}

func TestRunIacShowNone(t *testing.T) {
	c := &fakeClient{iacSource: nil}
	var buf bytes.Buffer
	if err := runIacShow(c, &buf, "table", "proj", ""); err != nil {
		t.Fatalf("runIacShow none: %v", err)
	}
	if !strings.Contains(buf.String(), "No BYO IaC source attached") {
		t.Errorf("expected empty notice, got: %q", buf.String())
	}
}

func TestRunIacShowError(t *testing.T) {
	c := &fakeClient{err: errors.New("boom")}
	if err := runIacShow(c, &bytes.Buffer{}, "table", "proj", ""); err == nil {
		t.Error("expected error to propagate")
	}
}
