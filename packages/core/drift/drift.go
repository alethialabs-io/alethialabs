// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Package drift turns the `resource_drift` section of an OpenTofu
// `plan -refresh-only -json` into a compact, storable per-environment posture —
// the "keep proving it" half of the elench verification story. A scheduled
// refresh-only job runs `tofu plan -refresh-only`, and this package summarises the
// divergence between recorded state and live cloud into a Posture row.
//
// Honest scope: a refresh-only plan only sees resources Terraform/OpenTofu manages
// (they are in state). It cannot see **unmanaged** resources that exist in the
// cloud but not in state — detecting those needs a cloud inventory source (AWS
// Config / Cloud Asset Inventory), tracked separately. Posture.Unmanaged is left
// at zero here, with Posture.UnmanagedKnown=false so a consumer never implies we
// checked for unmanaged resources when we did not.
package drift

import (
	"strconv"
	"strings"

	tfjson "github.com/hashicorp/terraform-json"
)

// Kind classifies a single drifted resource.
type Kind string

const (
	// KindModified — the resource still exists but its live configuration diverged
	// from state (refresh detected an update).
	KindModified Kind = "modified"
	// KindDeleted — the resource was deleted out-of-band (gone from the cloud).
	KindDeleted Kind = "deleted"
	// KindOther — any other drift action shape.
	KindOther Kind = "other"
)

// ResourceDrift is one drifted managed resource.
type ResourceDrift struct {
	Address string `json:"address"`
	Type    string `json:"type"`
	Kind    Kind   `json:"kind"`
}

// Posture is the storable drift summary for one environment at one point in time.
type Posture struct {
	// InSync is true when no managed resource has drifted.
	InSync bool `json:"in_sync"`
	// Drifted is the count of managed resources whose live state diverged.
	Drifted int `json:"drifted"`
	// Details lists the drifted resources (bounded by the plan size).
	Details []ResourceDrift `json:"details,omitempty"`
	// Unmanaged is the count of cloud resources not in state. Always 0 here.
	Unmanaged int `json:"unmanaged"`
	// UnmanagedKnown reports whether unmanaged detection actually ran (false for a
	// refresh-only plan — it cannot see unmanaged resources).
	UnmanagedKnown bool `json:"unmanaged_known"`
	// ScannedAt is an RFC3339 timestamp set by the caller (kept out of Analyze so
	// it stays deterministic for tests).
	ScannedAt string `json:"scanned_at,omitempty"`
}

// Analyze summarises the drift in a refresh-only plan. A nil plan (or one with no
// drift section) yields an in-sync posture. Pure and deterministic.
func Analyze(plan *tfjson.Plan) *Posture {
	p := &Posture{InSync: true}
	if plan == nil {
		return p
	}
	for _, rc := range plan.ResourceDrift {
		if rc == nil || rc.Change == nil {
			continue
		}
		// Data sources don't represent managed infrastructure drift.
		if rc.Mode == tfjson.DataResourceMode {
			continue
		}
		act := rc.Change.Actions
		if act.NoOp() {
			continue
		}
		p.Details = append(p.Details, ResourceDrift{
			Address: rc.Address,
			Type:    rc.Type,
			Kind:    classify(act),
		})
	}
	p.Drifted = len(p.Details)
	p.InSync = p.Drifted == 0
	return p
}

// classify maps a drift change's actions to a Kind.
func classify(act tfjson.Actions) Kind {
	switch {
	case act.Delete():
		return KindDeleted
	case act.Update():
		return KindModified
	default:
		return KindOther
	}
}

// Summary renders a one-line human summary of a posture.
func (p *Posture) Summary() string {
	if p == nil {
		return "drift: unknown"
	}
	if p.InSync {
		return "drift: in sync"
	}
	kinds := map[Kind]int{}
	for _, d := range p.Details {
		kinds[d.Kind]++
	}
	var parts []string
	if n := kinds[KindModified]; n > 0 {
		parts = append(parts, strconv.Itoa(n)+" modified")
	}
	if n := kinds[KindDeleted]; n > 0 {
		parts = append(parts, strconv.Itoa(n)+" deleted")
	}
	if n := kinds[KindOther]; n > 0 {
		parts = append(parts, strconv.Itoa(n)+" other")
	}
	return "drift: " + strconv.Itoa(p.Drifted) + " resource(s) (" + strings.Join(parts, ", ") + ")"
}
