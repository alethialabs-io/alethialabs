// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

// The cheap node shape must reach the CLI-authored project, or aws takes the template default
// (m5a.4xlarge x2) and the harness's own cost guard refuses the run before spending.
//
// The seeded path merges ALETHIA_E2E_CLUSTER_JSON into its snapshot. The CLI path has no snapshot —
// the CLI authors the project — so the same variable is translated into `--set` pairs. These pin
// the translation, because a shape that silently arrives empty produces a run that fails at the
// cost guard with no hint that the shape was the thing missing.

import (
	"strings"
	"testing"
)

func TestCLIDemoClusterSetsTranslatesTheWorkflowShape(t *testing.T) {
	// The real aws shape from e2e-nightly.yml, provider_config included so the nested-skip is
	// exercised by the thing that actually has one.
	t.Setenv("ALETHIA_E2E_CLUSTER_JSON",
		`{"instance_types":["t3.large"],"node_min_size":1,"node_max_size":2,`+
			`"node_desired_size":1,"node_disk_size_gb":20,"provider_config":{"enable_karpenter":true}}`)

	got := strings.Join(CLIDemoClusterSets(t), " ")
	for _, want := range []string{
		`--set instance_types=["t3.large"]`, // a JSON array, as `--set` documents
		"--set node_min_size=1",
		"--set node_max_size=2",
		"--set node_disk_size_gb=20",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("the translated shape is missing %q — the project would take a template default:\n%s", want, got)
		}
	}
	// provider_config is nested; `--set` takes scalars and JSON arrays, so it is skipped and SAID
	// rather than silently dropped.
	if strings.Contains(got, "provider_config") {
		t.Errorf("a nested object was emitted as a --set pair, which the CLI cannot parse:\n%s", got)
	}
}

// TestCLIDemoClusterSetsEmptyWhenNoShape — hetzner passes no override because its template default
// is already cents per run. Empty must mean "nothing to set", not a panic and not a default.
func TestCLIDemoClusterSetsEmptyWhenNoShape(t *testing.T) {
	t.Setenv("ALETHIA_E2E_CLUSTER_JSON", "")
	if got := CLIDemoClusterSets(t); len(got) != 0 {
		t.Errorf("no shape should translate to no --set pairs, got %v", got)
	}
}

// TestCLIDemoClusterSetsIsDeterministic — the argv must be reproducible from a failing run's log.
// Map iteration order is random in Go, so without sorting the same shape would produce a different
// command each time and a failure could not be re-run by hand.
func TestCLIDemoClusterSetsIsDeterministic(t *testing.T) {
	t.Setenv("ALETHIA_E2E_CLUSTER_JSON", `{"b":2,"a":1,"c":3,"d":4,"e":5}`)
	first := strings.Join(CLIDemoClusterSets(t), " ")
	for i := 0; i < 20; i++ {
		if got := strings.Join(CLIDemoClusterSets(t), " "); got != first {
			t.Fatalf("argv is not deterministic:\n%s\n%s", first, got)
		}
	}
}
