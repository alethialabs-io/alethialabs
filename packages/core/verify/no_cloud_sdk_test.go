// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package verify

import (
	"go/parser"
	"go/token"
	"os"
	"strings"
	"testing"
)

// TestVerifyDoesNotImportTheCloudyK8sPackage is the #2342 guard on this side of the seam.
//
// `verify` needs exactly one symbol from the k8s world — the manifest decoder — and it takes it
// from the k8s/manifest LEAF. Importing the parent `packages/core/k8s` instead compiles fine and
// changes no behaviour, which is precisely why it went unnoticed: the parent constructs a live EKS
// client, so the import silently puts the AWS SDK's whole dependency closure into every binary that
// imports this engine — including the Homebrew-distributed `alethia` CLI, which gained 21 indirect
// requirements that way.
//
// Nothing else in the tree fails when that import comes back, so this test is the tripwire.
func TestVerifyDoesNotImportTheCloudyK8sPackage(t *testing.T) {
	const parent = "github.com/alethialabs-io/alethialabs/packages/core/k8s"
	for name, imports := range directImports(t) {
		for _, path := range imports {
			if path == parent {
				t.Errorf("%s imports %q — use %q/manifest, the leaf. The parent holds a live EKS "+
					"client, and Go has no sub-package import granularity, so this import puts the "+
					"AWS SDK into every binary that imports verify, the `alethia` CLI included (#2342).",
					name, parent, parent)
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
