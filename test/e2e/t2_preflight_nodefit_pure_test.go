// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// FREE, every-PR proof for the #3855-cause-B pre-spend gate. NO build tag, NO cloud, NO credential:
// the whole point of this check is that it needs none of those, and the test that proves it needs
// none of them either.
package e2e

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func decodeShape(t *testing.T, raw string) map[string]any {
	t.Helper()
	var cluster map[string]any
	if err := json.Unmarshal([]byte(raw), &cluster); err != nil {
		t.Fatalf("decode %q: %v", raw, err)
	}
	return map[string]any{"cluster": cluster}
}

// TestControlPlaneNodeFitRefusesTheSHAPETHATBURNEDRun35499891484 is the regression.
//
// `1 x e2-medium` is what that nightly bought. It cleared t2RequireMaxConfigNodeShape (not a heavy
// run), it cleared t2RequireFabricDemoNodeShape (not a demo run), and it cleared the capacity
// preflight — `gcloud` confirmed e2-medium is sold in europe-west3-a, which it is. Then the apply
// succeeded, the nodes went Ready, and the run died at `argocd-ready` thirty-five minutes later.
// This is the question none of those three asked.
func TestControlPlaneNodeFitRefusesTheSHAPETHATBURNEDRun35499891484(t *testing.T) {
	t.Setenv("ALETHIA_E2E_T2_REQUIRE", "1")
	snapshot := decodeShape(t, `{"instance_types":["e2-medium"],"node_min_size":1,"node_max_size":2,"node_desired_size":1,"node_disk_size_gb":20}`)

	fatal, msg := t2RequireControlPlaneNodeFit("gcp", snapshot)
	if !fatal {
		t.Fatalf("the shape that burned run 35499891484 was not refused under REQUIRE: fatal=%v msg=%q", fatal, msg)
	}
	for _, want := range []string{"e2-medium", "e2-standard-2", "940m", "35499891484"} {
		if !strings.Contains(msg, want) {
			t.Errorf("the refusal never mentions %q:\n%s", want, msg)
		}
	}
}

// TestControlPlaneNodeFitWarnsRatherThanFailsOffCI mirrors every other prerequisite in this package:
// hard under ALETHIA_E2E_T2_REQUIRE, a warning for somebody running the harness by hand.
func TestControlPlaneNodeFitWarnsRatherThanFailsOffCI(t *testing.T) {
	t.Setenv("ALETHIA_E2E_T2_REQUIRE", "")
	fatal, msg := t2RequireControlPlaneNodeFit("gcp", decodeShape(t, `{"instance_types":["e2-medium"]}`))
	if fatal {
		t.Error("fatal off CI — a local run must not be blocked by this")
	}
	if msg == "" {
		t.Error("silent off CI, so somebody running by hand learns nothing")
	}
}

// TestControlPlaneNodeFitIsSilentOnWhatItCannotJUDGE. This runs on every leg of every nightly, on
// five clouds. Every case here is one where it has no evidence, and speaking would be noise while
// failing would be a guard blocking a run on arithmetic that does not apply to it.
func TestControlPlaneNodeFitIsSilentOnWhatItCannotJUDGE(t *testing.T) {
	t.Setenv("ALETHIA_E2E_T2_REQUIRE", "1")
	for _, tc := range []struct {
		name     string
		provider string
		snapshot map[string]any
	}{
		{"the gcp shape this workflow now buys", "gcp", decodeShape(t, `{"instance_types":["e2-standard-2"]}`)},
		{"the aws floor, whose node reservations are not modelled", "aws", decodeShape(t, `{"instance_types":["t3.large"]}`)},
		{"the azure floor", "azure", decodeShape(t, `{"instance_types":["Standard_D2s_v3"]}`)},
		{"the alibaba floor", "alibaba", decodeShape(t, `{"instance_types":["ecs.e-c1m2.large"]}`)},
		{"hetzner, which pins nothing and takes the template default", "hetzner", map[string]any{"cluster": map[string]any{}}},
		{"a snapshot with no cluster block at all", "gcp", map[string]any{}},
		{"a machine type the catalog has never heard of", "gcp", decodeShape(t, `{"instance_types":["e2-nonesuch-9"]}`)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fatal, msg := t2RequireControlPlaneNodeFit(tc.provider, tc.snapshot)
			if fatal || msg != "" {
				t.Errorf("spoke when it had nothing to say: fatal=%v msg=%q", fatal, msg)
			}
		})
	}
}

// TestControlPlaneNodeFitChecksEveryPinnedTypeNotJustTheFirst. snapshotInstanceType — the helper the
// capacity preflight uses — reads `[0]` on purpose. Reusing it here would have made a mixed pool
// whose SECOND member is too small pass, which is the hardest version of this defect to diagnose:
// most pods schedule, one does not, and only sometimes.
func TestControlPlaneNodeFitChecksEveryPinnedTypeNotJustTheFirst(t *testing.T) {
	t.Setenv("ALETHIA_E2E_T2_REQUIRE", "1")
	fatal, msg := t2RequireControlPlaneNodeFit("gcp", decodeShape(t, `{"instance_types":["e2-standard-4","e2-medium"]}`))
	if !fatal {
		t.Fatalf("a pool whose second member is too small was allowed: msg=%q", msg)
	}
	if strings.Contains(msg, "e2-standard-4") {
		t.Errorf("the message blames the member that is fine:\n%s", msg)
	}
}

// TestGCPFloorShapeCanHostTheControlPlane is what makes the string literal in
// gcp_location_contract_pure_test.go mean something.
//
// That contract pins the shape's TEXT, so it reds if anybody edits the line — but it would go on
// passing if the pinned text were updated to another shape that cannot host the add-ons, which is
// exactly how `e2-medium` got in. This reads the shape out of the workflow and puts it through the
// product's own catalog, so the floor can never again buy a node the product would refuse to sell a
// customer.
//
// It parses the workflow rather than taking the literal from the sibling test, deliberately: two
// tests agreeing about a string neither of them read from the file is not a check.
func TestGCPFloorShapeCanHostTheControlPlane(t *testing.T) {
	t.Setenv("ALETHIA_E2E_T2_REQUIRE", "1")
	root := filepath.Join(e2ePackageDir(t), "..", "..")
	workflow := filepath.Join(root, ".github", "workflows", "e2e-nightly.yml")
	body, err := os.ReadFile(workflow)
	if err != nil {
		t.Fatalf("read %s: %v", workflow, err)
	}

	// The `gcp)` arm of the `Compute cluster shape` case block, up to the closing quote.
	re := regexp.MustCompile(`(?m)^\s*gcp\)\s+SHAPE='(\{.*\})'\s*;;\s*$`)
	m := re.FindSubmatch(body)
	if m == nil {
		t.Fatalf("no `gcp) SHAPE='{…}'` line in %s — this guard has lost its subject and must be repointed, not deleted", workflow)
	}

	fatal, msg := t2RequireControlPlaneNodeFit("gcp", decodeShape(t, string(m[1])))
	if fatal || msg != "" {
		t.Errorf("the gcp floor shape in %s cannot host the control plane:\n%s\n  shape: %s", workflow, msg, m[1])
	}
}
