// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// clusterWith builds the smallest ProjectConfig this gate looks at.
func clusterWith(instanceTypes ...string) *types.ProjectConfig {
	cfg := &types.ProjectConfig{}
	cfg.Cluster.InstanceTypes = instanceTypes
	return cfg
}

// TestNodeFitGateBlocksTheApplyThatWOULDHaveWASTEDThirtyFiveMinutes is the regression.
//
// `gcp` + `e2-medium` is not a contrived case: it is what e2e run 35499891484 provisioned, from
// what was then the product's own default, and what it then spent its whole budget failing to
// install ArgoCD onto.
func TestNodeFitGateBlocksTheApplyThatWOULDHaveWASTEDThirtyFiveMinutes(t *testing.T) {
	got := nodeFitBlock("gcp", clusterWith("e2-medium"), false)

	if !got.Blocked {
		t.Fatalf("a real apply onto e2-medium was allowed through: %+v", got)
	}
	for _, want := range []string{
		"e2-medium",        // the shape that was refused
		"e2-standard-2",    // the way out
		"940m",             // the number, so the refusal can be checked rather than believed
		"35499891484",      // the evidence, so it can be looked up
		SkipNodeFitGateEnv, // the override, so a user who disagrees is not stuck
	} {
		if !strings.Contains(got.Message, want) {
			t.Errorf("the refusal never mentions %q — a user cannot act on it:\n%s", want, got.Message)
		}
	}
}

// TestNodeFitGateWarnsOnAPlanAndBlocksOnlyTheApply. A plan spends nothing, so refusing to price a
// config would be hostile; staying silent would waste the one moment the user is still designing.
func TestNodeFitGateWarnsOnAPlanAndBlocksOnlyTheApply(t *testing.T) {
	plan := nodeFitBlock("gcp", clusterWith("e2-medium"), true)
	if plan.Blocked {
		t.Error("a plan was blocked; a plan creates nothing and must still be priceable")
	}
	if !strings.Contains(plan.Message, "WARNING") || !strings.Contains(plan.Message, "e2-standard-2") {
		t.Errorf("the plan says nothing useful:\n%s", plan.Message)
	}
	if !strings.Contains(plan.Message, "refused") {
		t.Errorf("the plan warning does not say the apply will be refused, so the user learns that at apply time instead:\n%s", plan.Message)
	}
}

// TestNodeFitGateIsSilentOnEverythingItCannotJUDGE.
//
// This runs on the live provisioning path for every deploy on every cloud. Each case below is one
// where the gate has no evidence, and in each the right answer is to say nothing and get out of the
// way — the failure mode being avoided is a gate that blocks a deploy because it does not recognise
// a machine type.
func TestNodeFitGateIsSilentOnEverythingItCannotJUDGE(t *testing.T) {
	for _, tc := range []struct {
		name     string
		provider string
		config   *types.ProjectConfig
	}{
		{"a shape with room to spare", "gcp", clusterWith("e2-standard-2")},
		{"another cloud, whose node reservations are not modelled", "aws", clusterWith("t3.medium")},
		{"a machine type the catalog has never heard of", "gcp", clusterWith("e2-nonesuch-9")},
		{"no machine type pinned — the template's own default applies", "gcp", clusterWith()},
		{"no config at all", "gcp", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, dryRun := range []bool{true, false} {
				got := nodeFitBlock(tc.provider, tc.config, dryRun)
				if got.Blocked {
					t.Errorf("dryRun=%v: blocked on no evidence: %s", dryRun, got.Message)
				}
				if got.Message != "" {
					t.Errorf("dryRun=%v: spoke when it had nothing to say: %s", dryRun, got.Message)
				}
			}
		})
	}
}

// TestNodeFitGateChecksEVERYPinnedTypeNotJustTheFirst.
//
// A node pool may be given a list, and the scheduler will place a pod on any member of it. One
// too-small entry reproduces the defect in its most confusing form — most pods schedule, one does
// not, intermittently — so `instance_types[0]` is the wrong thing to check.
func TestNodeFitGateChecksEVERYPinnedTypeNotJustTheFirst(t *testing.T) {
	got := nodeFitBlock("gcp", clusterWith("e2-standard-4", "e2-medium"), false)
	if !got.Blocked {
		t.Fatalf("a list whose SECOND entry is too small was allowed through: %+v", got)
	}
	if strings.Contains(got.Message, "e2-standard-4") {
		t.Errorf("the message blames the shape that is fine:\n%s", got.Message)
	}

	both := nodeFitBlock("gcp", clusterWith("e2-medium", "n1-standard-1"), false)
	if strings.Count(both.Message, "·") != 2 {
		t.Errorf("two refused shapes produced %d finding(s) — a user fixing one would be blocked again by the other:\n%s", strings.Count(both.Message, "·"), both.Message)
	}
}

// TestNodeFitGateOverrideProceedsButSTILLSPEAKS. An escape hatch that also silences the finding
// turns a recorded decision into an invisible one; the job log is the only place this is written
// down.
func TestNodeFitGateOverrideProceedsButSTILLSPEAKS(t *testing.T) {
	t.Setenv(SkipNodeFitGateEnv, "1")
	got := nodeFitBlock("gcp", clusterWith("e2-medium"), false)

	if got.Blocked {
		t.Fatal("the override did not take effect")
	}
	if !strings.Contains(got.Message, "e2-medium") || !strings.Contains(got.Message, SkipNodeFitGateEnv) {
		t.Errorf("the override proceeded quietly, so nothing records that it was used:\n%s", got.Message)
	}
}

// TestNodeFitGateOverrideReadsFalseAsFALSE. `ALETHIA_SKIP_NODE_FIT_GATE=0` is somebody turning the
// hatch OFF, usually by templating an env block. Reading any non-empty string as "on" would make
// that the most confusing possible way to disable a safety gate.
func TestNodeFitGateOverrideReadsFalseAsFALSE(t *testing.T) {
	for _, off := range []string{"", "0", "false", "FALSE", "no", " off "} {
		t.Run("off="+off, func(t *testing.T) {
			t.Setenv(SkipNodeFitGateEnv, off)
			if got := nodeFitBlock("gcp", clusterWith("e2-medium"), false); !got.Blocked {
				t.Errorf("%q disabled the gate", off)
			}
		})
	}
	for _, on := range []string{"1", "true", "yes", "please"} {
		t.Run("on="+on, func(t *testing.T) {
			t.Setenv(SkipNodeFitGateEnv, on)
			if got := nodeFitBlock("gcp", clusterWith("e2-medium"), false); got.Blocked {
				t.Errorf("%q did not enable the override", on)
			}
		})
	}
}

// TestNodeFitGateOverrideDoesNotReachAPlan. The hatch exists to let an apply through; a plan is
// never blocked, so applying it there would only replace an accurate warning with a quieter one.
func TestNodeFitGateOverrideDoesNotReachAPlan(t *testing.T) {
	t.Setenv(SkipNodeFitGateEnv, "1")
	if got := nodeFitBlock("gcp", clusterWith("e2-medium"), true); !strings.Contains(got.Message, "WARNING") {
		t.Errorf("the plan warning was swallowed by the apply override:\n%s", got.Message)
	}
}
