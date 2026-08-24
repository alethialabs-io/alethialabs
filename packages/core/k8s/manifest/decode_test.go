// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package manifest

import (
	"go/parser"
	"go/token"
	"os"
	"strings"
	"testing"
)

// TestDecodeStream covers the decoder directly at the leaf: a multi-document stream, the
// empty/null documents a `helm template` render routinely emits between charts, identity read out
// of metadata, and the raw body kept whole so callers need no second parse.
func TestDecodeStream(t *testing.T) {
	const stream = `
apiVersion: v1
kind: ConfigMap
metadata:
  name: cm
  namespace: app
data:
  k: v
---
---
null
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: dep
`
	got, err := Decode([]byte(stream))
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("Decode returned %d resources, want 2 (empty and null documents are skipped): %#v", len(got), got)
	}
	if got[0].Kind != "ConfigMap" || got[0].Name != "cm" || got[0].Namespace != "app" {
		t.Errorf("first resource identity = %+v, want ConfigMap/cm/app", got[0])
	}
	if got[1].Kind != "Deployment" || got[1].Name != "dep" || got[1].Namespace != "" {
		t.Errorf("second resource identity = %+v, want Deployment/dep with no namespace", got[1])
	}
	// Raw is the whole document: a caller reading an arbitrary field must not need a second parse.
	if data, ok := got[0].Raw["data"].(map[string]any); !ok || data["k"] != "v" {
		t.Errorf("Raw did not carry the full document: %#v", got[0].Raw)
	}
}

// TestDecodeRefusesMalformedYAML pins the error CONTRACT, not just the failure. Callers in verify
// and the chart scanner assert on this wording, and Decode must return no resources alongside an
// error — a half-decoded stream read as a whole one is how a control passes on manifests it never saw.
func TestDecodeRefusesMalformedYAML(t *testing.T) {
	got, err := Decode([]byte("kind: Service\n  name: [unclosed\n"))
	if err == nil || !strings.Contains(err.Error(), "invalid k8s YAML") {
		t.Fatalf("Decode error = %v, want an \"invalid k8s YAML\" error", err)
	}
	if got != nil {
		t.Fatalf("Decode returned %d resources alongside an error", len(got))
	}
}

// TestAsStringCoercesOnlyStrings pins the coercion the parent package's workload extractor shares.
func TestAsStringCoercesOnlyStrings(t *testing.T) {
	cases := []struct {
		in   any
		want string
	}{
		{"s", "s"}, {7, ""}, {nil, ""}, {map[string]any{}, ""}, {[]any{"a"}, ""}, {true, ""},
	}
	for _, c := range cases {
		if got := AsString(c.in); got != c.want {
			t.Errorf("AsString(%#v) = %q, want %q", c.in, got, c.want)
		}
	}
}

// TestLeafImportsNothingCloudy is the guard that makes #2342 stay fixed.
//
// The bug was structural, not behavioural: this decoder used to live beside a live EKS client, and
// because Go has no sub-package import granularity, every importer of `verify` inherited the AWS
// SDK — into the Homebrew-distributed CLI, for a YAML parser. Splitting the leaf out fixes it once;
// this test is what stops the next person re-coupling it, since nothing else would fail.
func TestLeafImportsNothingCloudy(t *testing.T) {
	allowed := map[string]bool{
		"bytes": true, "fmt": true, "gopkg.in/yaml.v3": true,
		// test-only
		"go/parser": true, "go/token": true, "os": true, "strings": true, "testing": true,
	}
	for name, imports := range directImports(t) {
		for _, path := range imports {
			if !allowed[path] {
				t.Errorf("%s imports %q — this package is a LEAF so that `verify`, and therefore the "+
					"`alethia` CLI, does not inherit a cloud SDK's dependency closure (#2342). "+
					"Put anything that talks to a cloud in packages/core/k8s instead.", name, path)
			}
		}
	}
}

// directImports returns every import path in every .go file of the current directory, keyed by
// file name. parser.ParseFile over an os.ReadDir listing rather than parser.ParseDir, which is
// deprecated as of Go 1.25.
func directImports(t *testing.T) map[string][]string {
	t.Helper()
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("reading the package directory: %v", err)
	}
	fset := token.NewFileSet()
	out := map[string][]string{}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".go") {
			continue
		}
		f, err := parser.ParseFile(fset, e.Name(), nil, parser.ImportsOnly)
		if err != nil {
			t.Fatalf("parsing %s: %v", e.Name(), err)
		}
		for _, imp := range f.Imports {
			out[e.Name()] = append(out[e.Name()], strings.Trim(imp.Path.Value, `"`))
		}
	}
	if len(out) == 0 {
		t.Fatal("no .go files parsed — the guard would pass vacuously")
	}
	return out
}
