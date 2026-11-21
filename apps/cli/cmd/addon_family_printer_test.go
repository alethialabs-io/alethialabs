// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

// The add-on commands and `activity` through the one writer: the json each mutation prints, the
// refusals with nobody to ask, and the one question `activity` still puts — after the table.

func TestAddonFamily_EnableAndDisablePrintOneResult(t *testing.T) {
	version := "4.15.1"
	enabled, err := addonEnable(&fakeClient{}, api.EnableAddonParams{
		Project: "shop", Env: "staging", AddonID: "ingress-nginx", Mode: "managed", Version: &version,
	})
	if err != nil {
		t.Fatalf("addonEnable: %v", err)
	}
	disabled, err := addonDisable(&fakeClient{}, "shop", "staging", "ingress-nginx")
	if err != nil {
		t.Fatalf("addonDisable: %v", err)
	}
	type doc struct {
		ID     string  `json:"id"`
		Kind   string  `json:"kind"`
		Action string  `json:"action"`
		Job    *JobRef `json:"job"`
		Object struct {
			Project string  `json:"project"`
			Env     string  `json:"env"`
			Enabled bool    `json:"enabled"`
			Mode    string  `json:"mode"`
			Version *string `json:"version"`
		} `json:"object"`
	}
	read := func(r MutationResult) doc {
		var out bytes.Buffer
		if err := testPrinter(&out, ui.FormatJSON).Result(r, nil); err != nil {
			t.Fatalf("Result: %v", err)
		}
		var d doc
		if err := json.Unmarshal(out.Bytes(), &d); err != nil {
			t.Fatalf("not one json document: %v\n%s", err, out.String())
		}
		return d
	}
	e := read(enabled)
	if e.ID != "ingress-nginx" || e.Kind != "addon" || e.Action != "updated" || e.Job != nil {
		t.Errorf("enable result = %+v", e)
	}
	if !e.Object.Enabled || e.Object.Mode != "managed" || e.Object.Version == nil || *e.Object.Version != "4.15.1" || e.Object.Env != "staging" {
		t.Errorf("enable object = %+v", e.Object)
	}
	d := read(disabled)
	if d.Action != "updated" || d.Object.Enabled || d.Object.Version != nil {
		t.Errorf("disable result = %+v", d)
	}

	// A person reads the verb, and a disable says nothing about the next apply.
	p, out, errOut := splitPrinter(ui.FormatTable)
	if err := printAddonEnable(p, disabled); err != nil {
		t.Fatalf("printAddonEnable: %v", err)
	}
	if !strings.Contains(out.String(), "Disabled add-on ingress-nginx in staging") || errOut.Len() != 0 {
		t.Errorf("disable said stdout %q stderr %q", out.String(), errOut.String())
	}
}

func TestAddonFamily_RefusalsAreTyped(t *testing.T) {
	_, noEnableID := addonEnable(&fakeClient{}, api.EnableAddonParams{})
	_, noDisableID := addonDisable(&fakeClient{}, "shop", "", "")
	_, badMode := canonicalAddonMode("helm")
	_, nothingInstalled := resolveAddonIDWithPrompt(t, &fakeClient{addons: &api.ProjectAddons{}})
	for _, tc := range []struct {
		name string
		err  error
		exit int
	}{
		{"enable without an id", noEnableID, 8},
		{"disable without an id", noDisableID, 8},
		{"a --mode outside the enum", badMode, 8},
		{"a picker over nothing installed", nothingInstalled, 6},
		{"no id and nobody to ask", errAddonIDRequired, 9},
	} {
		if e := clierr.From(tc.err); e == nil || e.Exit != tc.exit {
			t.Errorf("%s: err = %v, want exit %d", tc.name, tc.err, tc.exit)
		}
	}
}

// resolveAddonIDWithPrompt resolves with no id on a terminal, where the picker is allowed to open.
func resolveAddonIDWithPrompt(t *testing.T, c addonLister) (addonRef, error) {
	t.Helper()
	tailFormsTTY(t)
	authFormNoForm(t)
	return resolveAddonID(c, nil, "shop", "", addonDisablePrompt)
}

func TestAddonFamily_BumpWithNoAnswerIsStillAResult(t *testing.T) {
	r, err := addonBump(&fakeBumper{}, "shop", "", "ingress-nginx", false)
	if err != nil {
		t.Fatalf("addonBump: %v", err)
	}
	obj, ok := r.Object.(addonBumpObject)
	if !ok || r.Action != ResultUnchanged || bumpLink(obj.GitopsBumpResult) != "" {
		t.Errorf("an empty answer = %+v", r)
	}
}

// TestAddonFamily_EndToEnd drives the real tree for each refusal: stderr, its exit code, and an
// empty stdout.
func TestAddonFamily_EndToEnd(t *testing.T) {
	for _, tc := range []struct {
		name string
		args []string
		exit int
		says string
	}{
		{"disable without --yes", []string{"addon", "disable", "loki", "--project", "p1", "--no-input"}, 9, "--yes"},
		{"enable with no id and nobody to ask", []string{"addon", "enable", "--project", "p1", "--no-input"}, 9, "catalog id"},
		{"disable with no id and nobody to ask", []string{"addon", "disable", "--project", "p1", "--no-input"}, 9, "catalog id"},
		{"bump with no id and nobody to ask", []string{"addon", "bump", "--project", "p1", "--no-input"}, 9, "catalog id"},
		{"bump with no project and nobody to ask", []string{"addon", "bump", "loki", "--no-input"}, 9, "--project"},
		{"enable with a bad --mode", []string{"addon", "enable", "loki", "--project", "p1", "--mode", "helm"}, 8, "--mode"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, run := hygCliConfirmEnv(t)
			var code int
			stdout, stderr := captureStreams(t, func() { code = run(tc.args...) })
			if code != tc.exit {
				t.Errorf("exit code = %d, want %d", code, tc.exit)
			}
			if stdout != "" {
				t.Errorf("a refusal wrote to stdout: %q", stdout)
			}
			if !strings.Contains(stderr, tc.says) {
				t.Errorf("stderr does not name %q: %q", tc.says, stderr)
			}
			if muts := s.mutations(); len(muts) != 0 {
				t.Errorf("a refusal changed state: %v", muts)
			}
		})
	}

	t.Run("enable -o json prints one result and nothing else", func(t *testing.T) {
		_, run := hygCliConfirmEnv(t)
		var code int
		stdout, stderr := captureStreams(t, func() {
			code = run("addon", "enable", "loki", "--project", "p1", "--env", "e1", "-o", "json")
		})
		if code != 0 {
			t.Fatalf("exit code = %d: %s", code, stderr)
		}
		var doc struct {
			ID     string `json:"id"`
			Action string `json:"action"`
		}
		if err := json.Unmarshal([]byte(stdout), &doc); err != nil || doc.ID != "loki" || doc.Action != "updated" {
			t.Errorf("stdout = %q (%v)", stdout, err)
		}
		if !strings.Contains(stderr, "next apply") {
			t.Errorf("the next step is not on stderr: %q", stderr)
		}
	})
}

// TestActivity_AsksForMoreOnlyAfterAFullPage drives `activity` on a terminal: the table is shown
// first, and only then — the page being full — is the person offered more rows; the larger read is
// shown and, the second page being short, nothing more is asked.
func TestActivity_AsksForMoreOnlyAfterAFullPage(t *testing.T) {
	run := covListEnv(t, covListPopulated)
	scripts := authFormAnswer(t, tailFormsDown(1))
	if code := run("activity", "-n", "1"); code != 0 {
		t.Fatalf("exit code = %d", code)
	}
	if !scripts[0].ran {
		t.Error("a full page was not followed by the offer of more rows")
	}
}
