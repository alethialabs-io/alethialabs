// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// A tofu variable with NO default is REQUIRED: every apply must supply it or tofu fails before it
// does anything. The runner supplies them from ProviderTfvars — so a template variable that has no
// default and is not emitted by ProviderTfvars breaks that cloud OUTRIGHT, for every project.
//
// Nothing was checking this. AWS alone has 18 required variables; adding a 19th (or renaming one)
// would break AWS silently, and `tofu validate` — which is all CI runs over the templates — cannot
// catch it, because validate never evaluates the caller's tfvars. That is the same blind spot that
// let GCP ship in a state where it could not provision AT ALL (#529): a whole class of template bug
// that only a real apply, or a check like this one, can see.
//
// The assertion uses a MINIMAL project on purpose. A required variable has no fallback, so it must
// be emitted for even the smallest project — if a key is only set when some feature is switched on,
// then the variable needs a default in the template, not a conditional in the emitter.

// templateRepoRoot resolves the monorepo root from this test file's own location, so the test does
// not depend on the working directory `go test` was invoked from.
func templateRepoRoot(t *testing.T) string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	root, err := filepath.Abs(filepath.Join(filepath.Dir(thisFile), "..", "..", ".."))
	if err != nil {
		t.Fatalf("resolve repo root: %v", err)
	}
	return root
}

// requiredTemplateVars returns the names of every variable declared in the given template directory
// that has NO default — i.e. the ones the caller is obliged to supply.
//
// This is a deliberately small HCL reader rather than a full parser: it tracks brace depth so that a
// `default` nested inside a `validation { … }` block is not mistaken for the variable's own default.
//
// It must also catch the one-line form — `variable "waf_logging_enabled" {}` — which is real in the
// AWS template and is the easy thing to miss: a reader that expects the closing brace on its own
// line silently skips those variables, and the guard then passes vacuously. TestRequiredTemplateVars
// pins both forms for exactly that reason.
func requiredTemplateVars(t *testing.T, dir string) []string {
	t.Helper()

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read template dir %s: %v", dir, err)
	}

	var required []string
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".tf") {
			continue
		}
		src, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			t.Fatalf("read %s: %v", e.Name(), err)
		}

		var (
			name       string // non-empty while inside a variable block
			depth      int    // brace depth relative to the variable block
			hasDefault bool
		)
		for _, line := range strings.Split(string(src), "\n") {
			trimmed := strings.TrimSpace(line)

			if name == "" {
				if after, found := strings.CutPrefix(trimmed, `variable "`); found {
					if end := strings.Index(after, `"`); end > 0 {
						name, depth, hasDefault = after[:end], 0, false
					}
				}
				if name == "" {
					continue
				}
			}

			// `default` counts only at the variable block's own level (depth 1 once the opening
			// brace on the `variable "x" {` line is counted below).
			if depth == 1 && strings.HasPrefix(trimmed, "default") {
				hasDefault = true
			}

			depth += strings.Count(line, "{") - strings.Count(line, "}")
			if depth <= 0 { // variable block closed
				if !hasDefault {
					required = append(required, name)
				}
				name = ""
			}
		}
	}
	return required
}

// TestRequiredTemplateVars pins the reader itself. If it silently under-counts, the guard below
// still passes — the variables it failed to see are simply never checked — so the reader has to be
// verified independently, in both directions.
func TestRequiredTemplateVars(t *testing.T) {
	dir := t.TempDir()
	src := `
variable "needs_a_value" {
  type = string
}

variable "one_line_no_default" {}

variable "has_a_default" {
  type    = string
  default = "x"
}

variable "default_is_empty_string" {
  type    = string
  default = ""
}

variable "validation_block_is_not_a_default" {
  type = number
  validation {
    condition     = var.validation_block_is_not_a_default > 0
    error_message = "must be positive"
  }
}
`
	if err := os.WriteFile(filepath.Join(dir, "variables.tf"), []byte(src), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	got := map[string]bool{}
	for _, v := range requiredTemplateVars(t, dir) {
		got[v] = true
	}

	// No default -> required. The one-line and validation-block forms are the ones a naive reader
	// misses; an empty-string default is still a default.
	for _, want := range []string{"needs_a_value", "one_line_no_default", "validation_block_is_not_a_default"} {
		if !got[want] {
			t.Errorf("%q has no default but was not reported as required", want)
		}
	}
	for _, unwanted := range []string{"has_a_default", "default_is_empty_string"} {
		if got[unwanted] {
			t.Errorf("%q HAS a default but was reported as required", unwanted)
		}
	}
}

// TestEveryRequiredTemplateVarIsEmitted asserts, for every cloud, that ProviderTfvars supplies every
// template variable that has no default — so no cloud can ship in a state where a from-zero apply
// dies on an unset variable.
func TestEveryRequiredTemplateVarIsEmitted(t *testing.T) {
	root := templateRepoRoot(t)

	// `local` has no CloudProvider, so it has no emitter to check against.
	providers := []string{"aws", "azure", "gcp", "alibaba", "hetzner"}

	for _, name := range providers {
		t.Run(name, func(t *testing.T) {
			p, err := NewCloudProvider(name)
			if err != nil {
				t.Fatalf("NewCloudProvider(%q): %v", name, err)
			}

			// The smallest project this cloud can express. A required variable must be emitted even
			// here — see the note at the top of the file.
			minimal := &types.ProjectConfig{
				ProjectName:    "min",
				CloudAccountID: "acct-1",
				Region:         "us-east-1",
				Cluster:        types.ProjectClusterConfig{ProviderConfig: map[string]any{}},
				DNS:            types.ProjectDNSConfig{ProviderConfig: map[string]any{}},
			}

			emitted := p.ProviderTfvars(minimal)
			required := requiredTemplateVars(t, filepath.Join(root, "infra", "templates", "project", name))

			if len(required) == 0 {
				t.Fatalf("parsed 0 required variables for %s — the template reader is broken, not the template", name)
			}

			for _, v := range required {
				if _, ok := emitted[v]; !ok {
					t.Errorf("template variable %q has no default and is NOT emitted by ProviderTfvars — a from-zero %s apply would fail on an unset required variable", v, name)
				}
			}
		})
	}
}
