// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Package drift turns the `resource_drift` section of an OpenTofu
// `plan -refresh-only -json` into a compact, storable per-environment posture —
// the "keep proving it" half of the elench verification story. A scheduled
// refresh-only job runs `tofu plan -refresh-only`, and this package summarises the
// divergence between recorded state and live cloud into a Posture row.
//
// Not every refresh delta is drift. A provider routinely returns a value its own
// create never recorded — an unset collection coming back as an empty one, a deprecated
// field newly hydrated — and reporting those as drift means a clean apply is reported
// as 28% drifted on day zero, which is how a detection feature loses its reader. Those
// representational deltas are classified out (see normalize.go) and counted separately
// in Normalized/NormalizedDetails, so what was examined and dismissed stays visible
// instead of turning into silence.
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
	// Attributes are the attribute paths that actually differed, sorted — e.g.
	// ["network[0].alias_ips", "placement_group_id"].
	//
	// Carried for the same reason NormalizedResource.Attributes is, and as the same
	// slice-of-strings shape for the same reason (the console's metadata scrub is a KEY
	// denylist, so paths must travel as values or an attribute named `client_secret`
	// would be deleted from the audit record).
	//
	// Until this existed, a DISMISSED delta named its attributes and a REAL one did not —
	// so "9 resources dismissed, here is exactly what" sat next to "5 resources drifted,
	// good luck". Diagnosing #2503 needed the leaf paths and had to reach for a live
	// cluster to get them.
	//
	// PATHS TRAVEL; VALUES NEVER DO. A path here can name a sensitive attribute —
	// `admin_password`, `client_secret`, a token field. That is deliberate on both sides:
	// the scrub does not remove it (above), and the assembly in normalize.go copies
	// `leafDelta.path` for EVERY differing leaf without consulting `leafDelta.sensitive`.
	//
	// What never travels is the VALUE, and that is structural rather than a rule someone has
	// to keep applying. This type has no field that could hold one; the before/after values
	// live in unexported fields of an unexported type, which is why normalize.go can state
	// that they "are carried for classification only and never escape the package". So a
	// record can say `admin_password` changed and cannot say what it changed to.
	//
	// Note the sensitivity flag pushes the other way: a sensitive leaf can never be dismissed
	// as merely normalizing (normalize.go's `d.sensitive` guard), so a sensitive attribute is
	// MORE likely to surface here as real drift, not less. This property carries weight.
	//
	// A path is still a disclosure — knowing the admin password drifted is knowing something —
	// and it is the least a reader needs to act on it. Anything rendering these should treat
	// them as attribute names worth showing, never as handles to resolve back to a value:
	// that lookup is the step this shape exists to prevent.
	//
	// EMPTY IS NOT "no attributes differed". Several drift verdicts are reached before the
	// leaves are computed at all — a non-update action, or a change whose before/after do
	// not parse as objects. Those are honestly attribute-less rather than attribute-free,
	// which is why this is `omitempty` and why nothing should read emptiness as a claim.
	Attributes []string `json:"attributes,omitempty"`
}

// Posture is the storable drift summary for one environment at one point in time.
type Posture struct {
	// InSync is true when no managed resource has drifted.
	InSync bool `json:"in_sync"`
	// Drifted is the count of managed resources whose live state diverged.
	Drifted int `json:"drifted"`
	// Details lists the drifted resources (bounded by the plan size).
	Details []ResourceDrift `json:"details,omitempty"`
	// Normalized counts resources whose ONLY refresh deltas were representational —
	// a difference in how the provider encodes a value, not a difference in the
	// infrastructure. Excluded from Drifted by construction.
	Normalized int `json:"normalized"`
	// NormalizedDetails records what was examined and dismissed, and why. Kept rather
	// than dropped so the dismissal is auditable: "32 resources examined, 9 deltas
	// found, 9 dismissed as representational, here they are" is a control that can be
	// shown to have operated. A bare "0 drifted" is not.
	NormalizedDetails []NormalizedResource `json:"normalized_details,omitempty"`
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
//
// It consults the plan alone. A caller that can also produce the workspace's provider
// schemas should call AnalyzeWithSchemas instead: without them, a provider-computed
// read-only attribute (a server-set timestamp, an ARN, a generation counter) is reported
// as drift on every scan, forever, because only an apply could rewrite state and a
// refresh-only check never applies (#3099).
func Analyze(plan *tfjson.Plan) *Posture {
	return AnalyzeWithSchemas(plan, nil)
}

// AnalyzeWithSchemas is Analyze with one extra piece of evidence: the schemas of the
// providers the plan's workspace uses, as `tofu providers schema -json` returns them.
//
// The schemas are used for exactly one thing — telling an attribute configuration CAN
// set apart from one it CANNOT. An attribute the schema marks Computed and neither
// Optional nor Required has no config path into it, so no configured intent governs it
// and no apply converges it; those deltas are dismissed as ReasonComputedAttribute. See
// normalize.go's Tier 3 for the full argument and its limits.
//
// Passing nil is not an error and not a degraded mode with different rules: it is the
// absence of evidence, and the schema-aware tier simply never fires. A nil-schema call is
// verdict-for-verdict identical to Analyze — which is what lets an existing caller adopt
// this incrementally without any posture changing under it.
//
// Pure and deterministic in both arguments.
func AnalyzeWithSchemas(plan *tfjson.Plan, schemas *tfjson.ProviderSchemas) *Posture {
	p := &Posture{InSync: true}
	if plan == nil {
		return p
	}
	cfg := indexConfig(plan)
	schemaIdx := indexSchemas(schemas)
	for _, rc := range plan.ResourceDrift {
		if rc == nil || rc.Change == nil {
			continue
		}
		// Data sources don't represent managed infrastructure drift.
		if rc.Mode == tfjson.DataResourceMode {
			continue
		}
		if rc.Change.Actions.NoOp() {
			continue
		}
		v := examine(rc, cfg, schemaIdx)
		if !v.Drift {
			p.NormalizedDetails = append(p.NormalizedDetails, NormalizedResource{
				Address:    rc.Address,
				Type:       rc.Type,
				Attributes: v.Attributes,
				Reason:     v.Reason,
			})
			continue
		}
		p.Details = append(p.Details, ResourceDrift{
			Address:    rc.Address,
			Type:       rc.Type,
			Kind:       v.Kind,
			Attributes: v.Attributes,
		})
	}
	p.Drifted = len(p.Details)
	p.Normalized = len(p.NormalizedDetails)
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
		return "drift: in sync" + p.normalizedSuffix()
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
	return "drift: " + strconv.Itoa(p.Drifted) + " resource(s) (" + strings.Join(parts, ", ") + ")" + p.normalizedSuffix()
}

// normalizedSuffix renders the dismissed-delta tail, and only when there is one — so
// every existing summary string is byte-identical when nothing was dismissed.
func (p *Posture) normalizedSuffix() string {
	if p.Normalized == 0 {
		return ""
	}
	return " [+" + strconv.Itoa(p.Normalized) + " normalized]"
}
