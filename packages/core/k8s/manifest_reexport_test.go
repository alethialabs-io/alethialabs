// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package k8s

import (
	"reflect"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/k8s/manifest"
)

// TestResourceIsAnAliasNotACopy pins the compatibility seam left by #2342.
//
// `Resource` must be a type ALIAS of manifest.Resource, not a defined type: the runner
// (agent.chart_scan), the provisioner and test/e2e all still say `k8s.Resource`, while `verify`
// says `manifest.Resource`, and values cross between them. Turning the alias into a definition
// compiles here but splits the two into incompatible types at every call site — so the assignment
// below, in both directions, is the assertion.
func TestResourceIsAnAliasNotACopy(t *testing.T) {
	// A compile-time assertion: passing a k8s.Resource where a manifest.Resource is required only
	// compiles while the two are the SAME type. `type Resource manifest.Resource` — a definition
	// rather than an alias — would require an explicit conversion and fail to build here, and at
	// every call site that hands a decoded resource across the seam.
	kindOf := func(r manifest.Resource) string { return r.Kind }
	if got := kindOf(Resource{Kind: "ConfigMap", Name: "cm"}); got != "ConfigMap" {
		t.Fatalf("kindOf = %q, want ConfigMap", got)
	}
	// And a runtime one, so the intent survives a refactor that satisfies the compiler by adding a
	// conversion above: a defined type reports its own name and package here, an alias does not.
	if a, b := reflect.TypeOf(Resource{}), reflect.TypeOf(manifest.Resource{}); a != b {
		t.Fatalf("k8s.Resource is %v and manifest.Resource is %v — they must be one type, or the "+
			"runner, the provisioner and verify silently stop sharing a decoder's output (#2342)", a, b)
	}
}

// TestDecodeReExportResolvesToTheLeaf proves the re-export is live — one decoder, reached by both
// names — rather than a shim that drifted from what the leaf actually does.
func TestDecodeReExportResolvesToTheLeaf(t *testing.T) {
	const doc = "apiVersion: v1\nkind: Secret\nmetadata:\n  name: s\n  namespace: ns\n"
	viaParent, err := Decode([]byte(doc))
	if err != nil {
		t.Fatalf("k8s.Decode: %v", err)
	}
	viaLeaf, err := manifest.Decode([]byte(doc))
	if err != nil {
		t.Fatalf("manifest.Decode: %v", err)
	}
	if len(viaParent) != 1 || len(viaLeaf) != 1 || !reflect.DeepEqual(viaParent[0], viaLeaf[0]) {
		t.Fatalf("k8s.Decode = %#v, manifest.Decode = %#v — they must be one implementation", viaParent, viaLeaf)
	}
}
