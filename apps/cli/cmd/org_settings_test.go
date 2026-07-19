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

func TestRunOrgSettings(t *testing.T) {
	c := &fakeClient{orgSettings: &api.OrgSettings{
		Name: "Acme", Slug: "acme", Description: "The Acme org", Region: "eu-west-1",
		DefaultEnv: "staging", TerraformVersion: "1.9.5",
	}}
	var buf bytes.Buffer
	if err := runOrgSettings(c, &buf, "table"); err != nil {
		t.Fatalf("runOrgSettings: %v", err)
	}
	out := buf.String()
	for _, want := range []string{"Acme", "acme", "eu-west-1", "staging", "1.9.5"} {
		if !strings.Contains(out, want) {
			t.Errorf("table output missing %q:\n%s", want, out)
		}
	}
}

func TestRunOrgSettingsJSON(t *testing.T) {
	c := &fakeClient{orgSettings: &api.OrgSettings{Name: "Acme", Slug: "acme", Region: "eu-west-1"}}
	var buf bytes.Buffer
	if err := runOrgSettings(c, &buf, "json"); err != nil {
		t.Fatalf("runOrgSettings json: %v", err)
	}
	if !strings.Contains(buf.String(), `"name": "Acme"`) {
		t.Errorf("json output unexpected:\n%s", buf.String())
	}
}

func TestRunOrgSettingsCommunity(t *testing.T) {
	c := &fakeClient{orgSettings: nil}
	var buf bytes.Buffer
	if err := runOrgSettings(c, &buf, "table"); err != nil {
		t.Fatalf("runOrgSettings community: %v", err)
	}
	if !strings.Contains(buf.String(), "community mode") {
		t.Errorf("expected community notice, got: %q", buf.String())
	}
}

func TestRunOrgSettingsError(t *testing.T) {
	c := &fakeClient{err: errors.New("boom")}
	if err := runOrgSettings(c, &bytes.Buffer{}, "table"); err == nil {
		t.Error("expected error to propagate")
	}
}
