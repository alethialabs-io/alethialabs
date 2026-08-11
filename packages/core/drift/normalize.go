// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package drift

import (
	"reflect"
	"sort"
	"strconv"
	"strings"

	tfjson "github.com/hashicorp/terraform-json"
)

// NormalizedReason names why a refresh delta was dismissed as representational
// rather than counted as drift. Values are stable — they appear in the job log and
// in execution_metadata, which is the evidence trail behind the CC7.1 control.
type NormalizedReason string

const (
	// ReasonEmptyCollection — a collection attribute moved between null/absent and an
	// EMPTY list or map. Both encode "no elements", so no infrastructure differs.
	ReasonEmptyCollection NormalizedReason = "empty_collection"
	// ReasonUndeclaredCollection — a top-level collection attribute the configuration
	// does not declare materialised from null. The provider's Read now returns a value
	// its Create did not record; no configured intent governs the attribute.
	ReasonUndeclaredCollection NormalizedReason = "undeclared_collection"
)

// NormalizedResource is one resource whose EVERY refresh delta was representational.
//
// It carries attribute PATHS and never attribute VALUES. Plan JSON attribute values
// are plaintext secrets — DB passwords, kubeconfigs, cloud tokens (see
// packages/core/tofu/tofu.go, ShowPlanJSON) — and a Posture is marshalled into the job
// log, posted to execution_metadata and stored in Postgres. Attribute paths are
// provider-schema public data; the values behind them are not, and never enter here.
type NormalizedResource struct {
	Address string `json:"address"`
	Type    string `json:"type"`
	// Attributes are the dismissed attribute paths, sorted — e.g.
	// ["default_node_pool[0].tags", "tags"].
	//
	// A slice of STRINGS, deliberately not a map keyed by attribute name: the console's
	// metadata scrub is a KEY denylist, so an attribute legitimately named
	// `client_secret` would be silently deleted from the audit record if it appeared as
	// a key. Carried as values, the paths survive intact.
	Attributes []string         `json:"attributes,omitempty"`
	Reason     NormalizedReason `json:"reason"`
}

// verdict is the outcome of examining one drift entry. Kind is meaningful when Drift
// is true; Reason and Attributes when it is false.
type verdict struct {
	Drift      bool
	Kind       Kind
	Reason     NormalizedReason
	Attributes []string
}

// examine decides whether one drift entry is real drift or a representational delta —
// a difference in how the provider ENCODES a value rather than a difference in the
// infrastructure itself.
//
// It CONSUMES rc.Change.{Before,After,BeforeSensitive,AfterSensitive} and retains no
// attribute VALUE: only paths reach the verdict. See NormalizedResource for why that
// boundary matters.
//
// Three structural guards keep the dismissal narrow, and each one is load-bearing:
//
//   - Only a pure Update is ever dismissible. A resource deleted or recreated
//     out-of-band is drift, full stop, which is what keeps KindDeleted un-silenceable.
//   - Before and After must both parse as objects. An unreadable diff is not a diff we
//     may dismiss, so it stays drift.
//   - There must be at least one differing leaf. Otherwise a change carrying no
//     before/after at all would be dismissed vacuously — silence dressed as proof.
//
// A resource is dismissed only when EVERY differing leaf is representational. One real
// delta anywhere and the whole resource stays drift with its original Kind; resources
// are never partially forgiven.
func examine(rc *tfjson.ResourceChange, cfg configIndex) verdict {
	act := rc.Change.Actions
	asDrift := verdict{Drift: true, Kind: classify(act)}

	if !act.Update() {
		return asDrift
	}
	before, beforeOK := rc.Change.Before.(map[string]any)
	after, afterOK := rc.Change.After.(map[string]any)
	if !beforeOK || !afterOK {
		return asDrift
	}
	leaves := diffLeaves(before, after, rc.Change.BeforeSensitive, rc.Change.AfterSensitive)
	if len(leaves) == 0 {
		return asDrift
	}

	// Fail-closed on configuration: with no config section, or an address that does not
	// resolve to one, every attribute counts as declared and the config-aware tier never
	// fires. Missing evidence must never widen what we dismiss.
	declared, addrFound := cfg[configAddress(rc.Address)]
	configKnown := cfg != nil && addrFound

	// Report the WEAKEST justification used, not the strongest: a resource dismissed
	// partly on the config-aware tier is recorded as such, so the audit trail never
	// overstates how firm the dismissal was.
	reason := ReasonEmptyCollection
	attrs := make([]string, 0, len(leaves))
	for _, d := range leaves {
		r, ok := d.normalizing(declared, configKnown)
		if !ok {
			return asDrift
		}
		if r == ReasonUndeclaredCollection {
			reason = r
		}
		attrs = append(attrs, d.path)
	}
	sort.Strings(attrs)
	return verdict{Reason: reason, Attributes: attrs}
}

// normalizing reports whether one leaf delta is representational, and why.
//
// Tier 1 — null/absent <-> an EMPTY list or map, in either direction, at any depth.
// This cannot hide a real change, by cardinality: a collection's entire meaning is its
// element set, and null and [] both have the element set ∅. For something real to hide,
// an element would have to appear or disappear — and then the other side is non-empty
// and this tier does not fire. Scalars are excluded by construction: "" , 0 and false
// are NOT interchangeable with null, and a scalar flipping out-of-band
// (public_network_access_enabled, min_tls_version) is exactly what must stay visible.
//
// Tier 2 — null/absent -> a NON-EMPTY collection, at depth 0, on an attribute the
// configuration does not declare, not marked sensitive. The claim: if state records
// null after a successful create, the provider's own Read returned null at create time,
// so null -> populated means the provider's read behaviour changed (schema growth, an
// API version bump, a deprecated field newly hydrated) rather than infrastructure
// changing. Each narrowing closes a hole — collections only, because security-relevant
// out-of-band flips are overwhelmingly scalars; depth 0, because nested declaredness
// needs block-order reconciliation this does not attempt; not sensitive, because an
// undeclared SECRET materialising from null is precisely the event to surface.
//
// What Tier 2 deliberately stops catching: an out-of-band change to an undeclared,
// non-sensitive, top-level collection whose state value is null — a subnet added
// through the cloud console, say. That costs nothing this package ever claimed: such a
// resource is unmanaged, and the package doc plus UnmanagedKnown=false already state
// that a refresh-only plan cannot see unmanaged resources. The blind spot sits inside a
// boundary already declared honestly. It is also PERMANENT per attribute — a dismissal
// writes no state, so every later refresh sees the same null before-side and dismisses
// again.
func (d leafDelta) normalizing(declared map[string]struct{}, configKnown bool) (NormalizedReason, bool) {
	beforeNull := !d.beforeSet || d.before == nil
	afterNull := !d.afterSet || d.after == nil

	// Tier 1, both directions. tags {"a":"b"} -> {} is tags REMOVED out-of-band and must
	// stay drift, so only the null side may be empty-or-absent — never both sides
	// flattened to ∅ before comparing, which is how detection of sweep-handle removal
	// would be lost.
	if (beforeNull && emptyCollection(d.after)) || (afterNull && emptyCollection(d.before)) {
		return ReasonEmptyCollection, true
	}

	switch {
	case !configKnown, d.depth != 0, d.sensitive, !beforeNull, !isCollection(d.after):
		return "", false
	}
	if _, ok := declared[d.root]; ok {
		return "", false
	}
	return ReasonUndeclaredCollection, true
}

// isCollection reports whether v is a list or a map. Scalars are never collections.
func isCollection(v any) bool {
	switch v.(type) {
	case []any, map[string]any:
		return true
	default:
		return false
	}
}

// emptyCollection reports whether v is a zero-length list or map.
func emptyCollection(v any) bool {
	switch t := v.(type) {
	case []any:
		return len(t) == 0
	case map[string]any:
		return len(t) == 0
	default:
		return false
	}
}

// leafDelta is one differing leaf between the before and after objects. Values are
// carried for classification only and never escape the package.
type leafDelta struct {
	// path is the full attribute path, e.g. "default_node_pool[0].tags".
	path string
	// root is the top-level attribute the leaf sits under, e.g. "default_node_pool".
	root string
	// depth is 0 for a top-level attribute of the resource object.
	depth     int
	beforeSet bool
	before    any
	afterSet  bool
	after     any
	// sensitive is true when either sensitivity mask marks this position.
	sensitive bool
}

// side is one half of a lockstep walk: the value and whether its key was present at all.
type side struct {
	v   any
	set bool
}

// diffLeaves walks before and after in lockstep and returns every differing leaf,
// carrying the sensitivity masks down alongside the values.
//
// Objects descend by SORTED key: the package promises determinism and the posture is
// persisted, so map-iteration order would make one plan yield different JSON per run.
//
// A length-differing list is itself a LEAF, not a descent. This is the most important
// detail in the walk: subnet [4 objects] -> [3 objects] must surface as one leaf with
// both sides non-null, hence real drift. Descending by index would compare element 0 to
// element 0 and scatter a vanished subnet into a pile of small, individually benign
// deltas.
// Sensitivity is resolved once per TOP-LEVEL attribute and inherited by every leaf
// beneath it. That is exactly as fine-grained as it needs to be: sensitivity only gates
// the config-aware tier, which is depth-0 only. Tier 1 ignores it deliberately — an
// empty collection has no content to protect, so a sensitive-but-empty attribute would
// otherwise be reported as drift forever.
func diffLeaves(before, after map[string]any, beforeSens, afterSens any) []leafDelta {
	var out []leafDelta
	for _, k := range sortedUnionKeys(before, after) {
		b, bSet := before[k]
		a, aSet := after[k]
		sensitive := maskMarks(maskChildKey(beforeSens, k)) || maskMarks(maskChildKey(afterSens, k))
		walkLeaves(&out, k, k, 0, sensitive, side{v: b, set: bSet}, side{v: a, set: aSet})
	}
	return out
}

// walkLeaves descends one position of the lockstep walk, appending any differing leaves.
func walkLeaves(out *[]leafDelta, path, root string, depth int, sensitive bool, b, a side) {
	if reflect.DeepEqual(b.v, a.v) {
		return
	}
	if bm, ok := b.v.(map[string]any); ok {
		if am, ok2 := a.v.(map[string]any); ok2 {
			for _, k := range sortedUnionKeys(bm, am) {
				nb, nbSet := bm[k]
				na, naSet := am[k]
				walkLeaves(out, path+"."+k, root, depth+1, sensitive,
					side{v: nb, set: nbSet}, side{v: na, set: naSet})
			}
			return
		}
	}
	if bl, ok := b.v.([]any); ok {
		if al, ok2 := a.v.([]any); ok2 && len(bl) == len(al) {
			for i := range bl {
				p := path + "[" + strconv.Itoa(i) + "]"
				walkLeaves(out, p, root, depth+1, sensitive,
					side{v: bl[i], set: true}, side{v: al[i], set: true})
			}
			return
		}
	}
	*out = append(*out, leafDelta{
		path: path, root: root, depth: depth,
		beforeSet: b.set, before: b.v,
		afterSet: a.set, after: a.v,
		sensitive: sensitive,
	})
}

// sortedUnionKeys returns every key present in either map, sorted.
func sortedUnionKeys(a, b map[string]any) []string {
	seen := make(map[string]struct{}, len(a)+len(b))
	keys := make([]string, 0, len(a)+len(b))
	for k := range a {
		seen[k] = struct{}{}
		keys = append(keys, k)
	}
	for k := range b {
		if _, ok := seen[k]; !ok {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	return keys
}

// maskChildKey descends a sensitivity mask by object key. The masks mirror the value
// structure with sensitive positions replaced by true.
func maskChildKey(mask any, key string) any {
	if m, ok := mask.(map[string]any); ok {
		return m[key]
	}
	return nil
}

// maskMarks reports whether a sensitivity mask marks this position. A nested mask means
// something beneath is sensitive, which is treated as marking the whole position —
// conservative by design, since the cost of over-marking is a retained drift entry and
// the cost of under-marking is a dismissed secret.
func maskMarks(mask any) bool {
	switch v := mask.(type) {
	case bool:
		return v
	case map[string]any:
		return len(v) > 0
	case []any:
		return len(v) > 0
	default:
		return false
	}
}

// configIndex maps a config-normalised resource address to the set of top-level
// attribute names its configuration declares.
type configIndex map[string]map[string]struct{}

// indexConfig walks the plan's configuration, recursing through module calls, and
// indexes each resource's declared top-level attribute names by module-prefixed
// address. Returns nil when the plan carries no configuration section, which callers
// treat as "assume everything is declared" rather than guessing.
func indexConfig(plan *tfjson.Plan) configIndex {
	if plan.Config == nil || plan.Config.RootModule == nil {
		return nil
	}
	out := configIndex{}
	var walk func(m *tfjson.ConfigModule, prefix string)
	walk = func(m *tfjson.ConfigModule, prefix string) {
		if m == nil {
			return
		}
		for _, cr := range m.Resources {
			if cr == nil {
				continue
			}
			attrs := make(map[string]struct{}, len(cr.Expressions))
			for name := range cr.Expressions {
				attrs[name] = struct{}{}
			}
			out[prefix+cr.Address] = attrs
		}
		for name, mc := range m.ModuleCalls {
			if mc != nil {
				walk(mc.Module, prefix+"module."+name+".")
			}
		}
	}
	walk(plan.Config.RootModule, "")
	return out
}

// configAddress strips EVERY instance key from a resource address so it matches a
// configuration address, which is never instance-keyed:
//
//	module.vnet[0].azurerm_subnet.private -> module.vnet.azurerm_subnet.private
//	aws_instance.x["a.b"]                 -> aws_instance.x
//
// Deliberately NOT the first-bracket truncation used by verify.baseAddress, which
// yields "module.vnet" here and therefore never matches a count- or for_each-ed module
// — and every module in infra/templates uses count. Bracket-depth and quote aware, so a
// for_each key containing '.', '[' or ']' is handled rather than corrupting the address.
func configAddress(addr string) string {
	var sb strings.Builder
	depth, inQuote, escaped := 0, false, false
	for i := 0; i < len(addr); i++ {
		c := addr[i]
		if depth == 0 {
			if c == '[' {
				depth++
				continue
			}
			sb.WriteByte(c)
			continue
		}
		switch {
		case escaped:
			escaped = false
		case c == '\\':
			escaped = true
		case c == '"':
			inQuote = !inQuote
		case inQuote:
			// A bracket inside a quoted for_each key is literal, not structural.
		case c == '[':
			depth++
		case c == ']':
			depth--
		}
	}
	return sb.String()
}
