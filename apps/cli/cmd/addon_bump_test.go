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

// fakeBumper records the one call `bump` makes and answers with a canned result.
type fakeBumper struct {
	got   []any
	reply *api.GitopsBumpResult
	err   error
}

func (f *fakeBumper) RequestGitopsBump(project, env, addonID string, again bool) (*api.GitopsBumpResult, error) {
	f.got = []any{project, env, addonID, again}
	return f.reply, f.err
}

func bumpResult(status string) *api.GitopsBumpResult {
	r := &api.GitopsBumpResult{
		Status: status, Version: "4.15.1", File: "addons/ingress-nginx.yaml", Field: "spec.source.targetRevision",
	}
	if status != "refused" {
		n := 42
		r.Number, r.URL = &n, ptr("https://github.com/acme/apps/pull/42")
	} else {
		r.Reason, r.Message = ptr("provider-not-supported"), ptr("Alethia opens these pull requests on GitHub only.")
	}
	return r
}

// TestRunAddonBump (#6549): each answer is said with what to do next, a refusal always carries the
// manual instruction, and --again is passed through and nothing else sets it.
func TestRunAddonBump(t *testing.T) {
	for _, tc := range []struct {
		name  string
		reply *api.GitopsBumpResult
		again bool
		want  []string
	}{
		{"opened", func() *api.GitopsBumpResult { r := bumpResult("open"); r.Created = true; return r }(), false,
			[]string{"Pull request opened: #42 https://github.com/acme/apps/pull/42", "spec.source.targetRevision", "addons/ingress-nginx.yaml", "4.15.1"}},
		{"already open", bumpResult("open"), false, []string{"is already open: #42"}},
		{"merged", bumpResult("merged"), false, []string{"was merged", "The next deploy reads 4.15.1"}},
		{"declined", bumpResult("declined"), false, []string{"You closed pull request #42", "--again"}},
		{"refused", bumpResult("refused"), true,
			[]string{"No pull request was opened.", "GitHub only", "set spec.source.targetRevision in addons/ingress-nginx.yaml to 4.15.1"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := &fakeBumper{reply: tc.reply}
			var out bytes.Buffer
			if err := runAddonBump(f, &out, "acme", "prod", "ingress-nginx", tc.again); err != nil {
				t.Fatalf("runAddonBump: %v", err)
			}
			for _, w := range tc.want {
				if !strings.Contains(out.String(), w) {
					t.Errorf("output is missing %q:\n%s", w, out.String())
				}
			}
			if f.got[3] != tc.again {
				t.Errorf("again = %v, want %v", f.got[3], tc.again)
			}
		})
	}

	if err := runAddonBump(&fakeBumper{}, &bytes.Buffer{}, "acme", "", "", false); err == nil {
		t.Error("an empty add-on id was sent")
	}
	if err := runAddonBump(&fakeBumper{err: errors.New("boom")}, &bytes.Buffer{}, "acme", "", "x", false); err == nil {
		t.Error("an API error was swallowed")
	}
}
