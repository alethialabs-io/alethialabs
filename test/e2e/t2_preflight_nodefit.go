// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

import (
	"fmt"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/catalog"
)

// The pre-spend question the other preflights do not ask: CAN WHAT WE INSTALL RUN ON IT?
//
// `t2RequireMaxConfigNodeShape` asks whether the shape is big enough for what this RUN asserts.
// `t2RequireCapacityPreflight` asks whether the cloud will sell us that shape in this location. Both
// passed on run 35499891484 — correctly — and the run still burned its whole budget, because the
// shape it bought could not schedule argocd-repo-server, and could not schedule GKE's own
// calico-typha either. Neither existing question covers that, and the answer needs no cloud at all.
//
// This is the CHEAPEST of the three by a wide margin: no network, no CLI, no credential, a few
// microseconds against an embedded JSON document. It therefore runs FIRST, which also means a leg
// whose shape is wrong says so before it has waited on a `gcloud` call.
//
// ── One rule, one implementation ──
//
// The verdict comes from `catalog.ControlPlaneNodeFit`, the same function the product's own node-fit
// gate calls before a customer's apply. That is deliberate and is the point of putting the rule in
// `packages/core/catalog` rather than here: the floor shape this workflow buys and the shape a
// customer picks in the console are drawn from the SAME inventory, and `e2-medium` was that
// inventory's gcp default when it failed. A harness-local copy of the rule could quietly disagree
// with the product's, and the disagreement would be invisible until a nightly went red for a reason
// no customer could reproduce — or, worse, stayed green on a shape the product refuses to sell.

// snapshotInstanceTypes reads EVERY machine type the merged snapshot pins, not just the first.
//
// snapshotInstanceType (t2_preflight.go) deliberately reads only `[0]`, because the question it
// serves — "will the cloud sell us this?" — is asked of the type each ProviderTfvars actually
// resolves its pool from. This question is different: a node pool given a list will place a pod on
// ANY member, so one too-small entry is enough to reproduce the defect, in its most confusing form.
func snapshotInstanceTypes(snapshot map[string]any) []string {
	cluster, _ := snapshot["cluster"].(map[string]any)
	if cluster == nil {
		return nil
	}
	raw, ok := cluster["instance_types"].([]any)
	if !ok {
		return nil
	}
	var out []string
	for _, v := range raw {
		if s, _ := v.(string); strings.TrimSpace(s) != "" {
			out = append(out, strings.TrimSpace(s))
		}
	}
	return out
}

// t2RequireControlPlaneNodeFit refuses a shape measured unable to host the control plane.
//
// Returns (fatal, msg) on the same contract as every other prerequisite in this package: a refusal
// is fatal under ALETHIA_E2E_T2_REQUIRE (the nightly) and a warning off CI. Anything the catalog
// cannot model is silent — there is no third message here, because unlike the capacity preflight
// this check has no probe that can fail: "not modelled" is a permanent property of the cloud and the
// machine type, and a line per run announcing it would be noise rather than a record.
func t2RequireControlPlaneNodeFit(provider string, snapshot map[string]any) (fatal bool, msg string) {
	types := snapshotInstanceTypes(snapshot)
	if len(types) == 0 {
		return false, ""
	}
	c, err := catalog.Load()
	if err != nil {
		return false, fmt.Sprintf("control-plane node fit: the catalog would not load (%v), so no shape was checked — proceeding unverified", err)
	}

	var b strings.Builder
	for _, want := range types {
		fit := c.ControlPlaneNodeFit(provider, want)
		if fit.Verdict != catalog.FitTooSmall {
			continue
		}
		fmt.Fprintf(&b, "\n  · %s", fit.Detail)
		if fit.Suggestion != "" {
			fmt.Fprintf(&b, "\n    Use %q instead.", fit.Suggestion)
		}
	}
	if b.Len() == 0 {
		return false, ""
	}
	return t2RequireIsHard(), fmt.Sprintf(
		"control-plane node fit [REFUSE]: this leg's shape cannot host what the run installs onto it, so the cluster would come up healthy and then fail at `argocd-ready`.%s\n  Refused with no cloud call and nothing spent (catalog.ControlPlaneNodeFit — the same check the product runs before a customer's apply).",
		b.String())
}
