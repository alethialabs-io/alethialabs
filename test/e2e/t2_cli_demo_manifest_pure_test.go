// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

// The PURE half of the manifest beats (#3662): the two read-back assertions the `manifest-init`
// and `manifest-plan` beats hang on, held without a cloud.
//
// These functions decide whether a PAID run passes or fails, and every one of their branches is a
// verdict — "the writer and the reader disagree about the file format", "the file and the commands
// describe two different projects", "the connector has no label". A verdict branch that has never
// executed is a verdict nobody has seen, so the failure text is discovered on stage, on the one run
// where it fires. Untagged, like the sibling pure files, so ci.yml runs them on every PR.

import (
	"strings"
	"testing"
)

// TestAssertManifestPlanIsClean_Verdicts drives every arm: the refusal, the two identity checks,
// each of the three counts in the summary line, and the clean plan the beat exists to see.
//
// The run carries a project name and a region, because the assertion reads them out of the plan's
// header — a zero-valued run would make that check vacuous and the table would then prove only that
// the summary line was matched.
func TestAssertManifestPlanIsClean_Verdicts(t *testing.T) {
	run := &CLIDemoRun{Project: "cli-demo-42", Region: "nbg1"}
	// The header and the summary as a real run prints them. Cases vary one clause at a time.
	header := "▸ Reading alethia.yaml · cli-demo-42 · hetzner/nbg1\n"
	clean := header +
		"  development  dedicated  + environment\n" +
		"  production is on the server and not in the file — left alone\n" +
		"  0 projects to create · 1 environment · 0 components\n"

	cases := []struct {
		name string
		out  string
		// wantErr is a distinctive fragment of the expected message, or "" for success.
		wantErr string
	}{
		{
			name:    "a refused manifest names the writer/reader disagreement",
			out:     "alethia.yaml cannot be applied as written: environments[0].placement is not one of …",
			wantErr: "REFUSED the manifest",
		},
		{
			name:    "a plan that would create the project names the two-projects failure",
			out:     header + "  1 project to create · 1 environment · 0 components",
			wantErr: "0 projects to create · 1 environment · 0 components",
		},
		{
			name: "a clean plan passes",
			out:  clean,
		},
		{
			name:    "empty output is not silently a pass",
			out:     "",
			wantErr: "does not name",
		},
		{
			// The refusal arm is checked FIRST on purpose: a refused plan also lacks the
			// "0 projects to create" line, and reporting that as "the file describes a second
			// project" would send the reader after the wrong defect.
			name:    "a refusal is reported as a refusal, not as a project mismatch",
			out:     "alethia.yaml cannot be applied as written",
			wantErr: "REFUSED the manifest",
		},
		{
			// The file planned cleanly — against SOME OTHER project. Nothing in the counts can
			// see this; only the header can.
			name:    "a file naming another project is caught by the header",
			out:     "▸ Reading alethia.yaml · someone-elses · hetzner/nbg1\n  0 projects to create · 1 environment · 0 components",
			wantErr: "cli-demo-42",
		},
		{
			name:    "a file naming another region is caught by the header",
			out:     "▸ Reading alethia.yaml · cli-demo-42 · hetzner/fsn1\n  0 projects to create · 1 environment · 0 components",
			wantErr: "nbg1",
		},
		{
			// The case the old substring form could not see: everything before the first
			// separator is identical to a clean plan.
			name:    "the project matches and the environment count does not",
			out:     header + "  0 projects to create · 9 environments · 0 components",
			wantErr: "0 projects to create · 1 environment · 0 components",
		},
		{
			// The other half of it: the run would re-upsert components the file never declared.
			name:    "the components would be rewritten",
			out:     header + "  0 projects to create · 1 environment · 3 components",
			wantErr: "0 projects to create · 1 environment · 0 components",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := assertManifestPlanIsClean(run, tc.out)
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("wanted a clean verdict, got: %v", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("wanted an error containing %q, got nil", tc.wantErr)
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("error does not name the failure: wanted %q in\n%v", tc.wantErr, err)
			}
			if !strings.Contains(err.Error(), tc.out) && tc.out != "" {
				t.Error("the error does not carry the output it judged — the reader cannot see what it saw")
			}
		})
	}
}

// TestCaptureIdentityID_PicksTheProvidersLabelledAccount covers every arm of the read-back that
// feeds `--cloud-account`. The label arm is the one #3662 added: the beats address the account by
// the name a person types, so an unlabelled connector has to be refused HERE rather than surfacing
// as a `project create` failure three beats later.
func TestCaptureIdentityID_PicksTheProvidersLabelledAccount(t *testing.T) {
	cases := []struct {
		name      string
		provider  string
		out       string
		wantErr   string
		wantID    string
		wantLabel string
	}{
		{
			name:      "matches on provider and keeps both the id and the label",
			provider:  "hetzner",
			out:       `noise [{"id":"i-1","label":"HETZNER","provider":"hetzner"}] trailing`,
			wantID:    "i-1",
			wantLabel: "HETZNER",
		},
		{
			name:      "provider match is case-insensitive",
			provider:  "Hetzner",
			out:       `[{"id":"i-1","label":"HETZNER","provider":"HETZNER"}]`,
			wantID:    "i-1",
			wantLabel: "HETZNER",
		},
		{
			name:      "skips other clouds rather than taking the first entry",
			provider:  "aws",
			out:       `[{"id":"i-h","label":"HETZNER","provider":"hetzner"},{"id":"i-a","label":"AWS","provider":"aws"}]`,
			wantID:    "i-a",
			wantLabel: "AWS",
		},
		{
			name:     "an unlabelled account is refused, and the id is named",
			provider: "hetzner",
			out:      `[{"id":"i-1","label":"","provider":"hetzner"}]`,
			wantErr:  "has no label",
		},
		{
			name:     "no array at all",
			provider: "hetzner",
			out:      "Error: not logged in",
			wantErr:  "produced no JSON array",
		},
		{
			name:     "malformed array",
			provider: "hetzner",
			out:      `[{"id":]`,
			wantErr:  "parsing the connector list",
		},
		{
			name:     "no identity for this cloud",
			provider: "aws",
			out:      `[{"id":"i-1","label":"HETZNER","provider":"hetzner"}]`,
			wantErr:  "no aws identity among 1 connector(s)",
		},
		{
			name:     "an entry with an empty id is not a match",
			provider: "hetzner",
			out:      `[{"id":"","label":"HETZNER","provider":"hetzner"}]`,
			wantErr:  "no hetzner identity",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			run := &CLIDemoRun{Provider: tc.provider}
			err := captureIdentityID(run, tc.out)
			if tc.wantErr != "" {
				if err == nil {
					t.Fatalf("wanted an error containing %q, got nil", tc.wantErr)
				}
				if !strings.Contains(err.Error(), tc.wantErr) {
					t.Errorf("error does not name the failure: wanted %q in\n%v", tc.wantErr, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("wanted a capture, got: %v", err)
			}
			if run.IdentityID != tc.wantID {
				t.Errorf("IdentityID = %q, want %q", run.IdentityID, tc.wantID)
			}
			if run.IdentityLabel != tc.wantLabel {
				t.Errorf("IdentityLabel = %q, want %q — the beats address the account by label", run.IdentityLabel, tc.wantLabel)
			}
		})
	}
}

// TestCLIDemoManifestPath_IsDeterministicPerRun pins the property the two manifest beats depend on:
// `manifest-init` writes the file and `manifest-plan` reads it, with no field on the run to keep in
// step, so the path must be a pure function of the project and must not collide across projects.
func TestCLIDemoManifestPath_IsDeterministicPerRun(t *testing.T) {
	a := cliDemoManifestPath(&CLIDemoRun{Project: "boutique"})
	if got := cliDemoManifestPath(&CLIDemoRun{Project: "boutique"}); got != a {
		t.Errorf("the same run yields two paths (%q then %q) — init would write where plan does not read", a, got)
	}
	if b := cliDemoManifestPath(&CLIDemoRun{Project: "other"}); b == a {
		t.Error("two projects share one manifest path — concurrent runs would overwrite each other")
	}
	if !strings.HasSuffix(a, "alethia.yaml") {
		t.Errorf("path %q is not named alethia.yaml — `plan --file` is what reads it, but the demo is "+
			"meant to show the file a prospect commits", a)
	}
}
