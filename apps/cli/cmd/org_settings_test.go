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
	for _, want := range []string{"Acme", "acme", "The Acme org"} {
		if !strings.Contains(out, want) {
			t.Errorf("table output missing %q:\n%s", want, out)
		}
	}
	// The deprecated defaults are no longer shown to a person.
	for _, gone := range []string{"eu-west-1", "staging", "1.9.5", "region", "default env", "terraform"} {
		if strings.Contains(out, gone) {
			t.Errorf("table output still shows %q:\n%s", gone, out)
		}
	}
}

func TestRunOrgSettingsJSON(t *testing.T) {
	c := &fakeClient{orgSettings: &api.OrgSettings{
		Name: "Acme", Slug: "acme", Region: "eu-west-1", DefaultEnv: "staging", TerraformVersion: "1.9.5",
	}}
	var buf bytes.Buffer
	if err := runOrgSettings(c, &buf, "json"); err != nil {
		t.Fatalf("runOrgSettings json: %v", err)
	}
	// The JSON shape is unchanged: the deprecated keys are still in it for scripts.
	for _, want := range []string{`"name": "Acme"`, `"region": "eu-west-1"`, `"default_env": "staging"`, `"terraform_version": "1.9.5"`} {
		if !strings.Contains(buf.String(), want) {
			t.Errorf("json output missing %s:\n%s", want, buf.String())
		}
	}
}

func TestRunOrgSettingsCommunity(t *testing.T) {
	c := &fakeClient{orgSettings: nil}
	var buf bytes.Buffer
	// No organization means no record to print: the notice is on stderr and stdout stays empty.
	p, _, said := splitPrinter("table")
	withPrinter(t, p)
	if err := runOrgSettings(c, &buf, "table"); err != nil {
		t.Fatalf("runOrgSettings community: %v", err)
	}
	if !strings.Contains(said.String(), "community mode") {
		t.Errorf("expected community notice on stderr, got: %q", said.String())
	}
	if buf.Len() != 0 {
		t.Errorf("stdout is not empty: %q", buf.String())
	}
}

func TestRunOrgSettingsError(t *testing.T) {
	c := &fakeClient{err: errors.New("boom")}
	if err := runOrgSettings(c, &bytes.Buffer{}, "table"); err == nil {
		t.Error("expected error to propagate")
	}
}
