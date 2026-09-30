// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package drift

import (
	"reflect"
	"sort"
	"strconv"

	"github.com/alethialabs-io/alethialabs/packages/core/tfaddr"
	tfjson "github.com/hashicorp/terraform-json"
	"github.com/zclconf/go-cty/cty"
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
	// ReasonComputedAttribute — a top-level attribute the PROVIDER SCHEMA marks
	// Computed and neither Optional nor Required: read-only, server-set, not settable
	// from configuration at all. No configured intent can govern it and no apply can
	// converge it.
	ReasonComputedAttribute NormalizedReason = "computed_attribute"
	// ReasonSensitivityOnly — OpenTofu reported the resource as changed, yet every attribute
	// VALUE is identical and only the sensitivity MARKS differ (which paths OpenTofu redacts
	// when it renders the value). A mark is display metadata held in state, not a property of
	// the infrastructure. See sensitivityOnly for the full argument and its narrowings.
	ReasonSensitivityOnly NormalizedReason = "sensitivity_only"
	// ReasonAssignmentBackReference — the delta on this resource is exactly the reverse edge
	// of an assignment ANOTHER managed resource in the same state declares and still holds
	// (a primary IP or firewall reporting the server that attached it; an IAM role, security
	// group, route table, EIP or default NACL reporting the attachment resources that populate
	// it). See backref.go and awsbackref.go.
	ReasonAssignmentBackReference NormalizedReason = "assignment_back_reference"
	// ReasonInapplicableField — a field the cloud API ignores for this element moved from null to
	// its zero value: icmp_type/icmp_code on a network ACL rule whose protocol is not ICMP. No
	// traffic decision can differ. See awsInapplicableRoots (awsbackref.go).
	ReasonInapplicableField NormalizedReason = "inapplicable_field"
)

// reasonStrength ranks how firm each dismissal is, so examine can report the WEAKEST
// justification a resource actually used rather than the strongest. Higher is firmer.
//
// The ordering is an argument, not a preference:
//
//   - empty_collection (6) needs no external evidence at all. It is a cardinality
//     identity — null and [] both denote ∅ — so it is true by construction.
//   - sensitivity_only (5) is also an identity — every value on both sides is equal — but
//     it rests on facts about OpenTofu rather than none: that a resource whose values
//     are equal and whose types are equal (both sides are decoded against the same schema)
//     can only differ in its marks. That is how OpenTofu's drift comparison is written
//     (cty RawEquals compares marks), not a property of the data itself. Its schema-mark
//     form (schemaMarksOnly) also reads the provider schema, as computed_attribute does;
//     the ranking never has to choose between them, because a sensitivity_only verdict is
//     only ever reached with zero differing leaves and so is never combined with another.
//   - computed_attribute (4) rests on ONE fact read from the provider's own published
//     schema: the attribute has no config path into it. Firm, but it is a fact about a
//     document we fetched, and a wrong or stale schema would weaken it.
//   - undeclared_collection (3) rests on the absence of a config expression PLUS an
//     inference about how the provider's Read behaved at create time. Two links, the
//     second unverifiable from the plan.
//   - assignment_back_reference (2) rests on a HAND-WRITTEN claim about a provider's API
//     (that it reports an assignment made from the owner or an attachment resource back on
//     the target), verified against two views of state. The verification is strong, but the
//     claim it verifies is ours, not the provider's.
//   - inapplicable_field (1) rests on a HAND-WRITTEN claim about the cloud API's semantics
//     (that ICMP type/code mean nothing on a non-ICMP rule) and on nothing the state can
//     verify, so it ranks weakest.
//
// An unranked value sorts as the weakest possible, so adding a reason and forgetting to
// rank it can only understate a dismissal, never overstate one.
func reasonStrength(r NormalizedReason) int {
	switch r {
	case ReasonEmptyCollection:
		return 6
	case ReasonSensitivityOnly:
		return 5
	case ReasonComputedAttribute:
		return 4
	case ReasonUndeclaredCollection:
		return 3
	case ReasonAssignmentBackReference:
		return 2
	case ReasonInapplicableField:
		return 1
	default:
		return 0
	}
}

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

// verdict is the outcome of examining one drift entry. Kind is meaningful when Drift is
// true; Reason when it is false. Attributes is meaningful in BOTH directions — the paths
// that differed, whether they were dismissed or kept — and is empty only when the verdict
// was reached before the leaves could be computed.
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
//     The ONE exception needs positive evidence in place of a leaf: equal, number-free
//     values whose sensitivity masks differ (sensitivityOnly, marks.go), or whose equal
//     masks the PROVIDER SCHEMA explains (schemaMarksOnly, marks.go). Equal values with
//     equal masks and no such schema evidence remain drift.
//
// A resource is dismissed only when EVERY differing leaf is representational. One real
// delta anywhere and the whole resource stays drift with its original Kind; resources
// are never partially forgiven.
func examine(rc *tfjson.ResourceChange, cfg configIndex, schemas schemaIndex, traits traitIndex, st *stateIndex) verdict {
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
		// No VALUE differs, yet OpenTofu reported a change. Dismissible only on positive
		// evidence of what did change — the sensitivity marks, either printed differently or
		// explained by the provider schema — never merely because nothing visible did (that
		// would be the vacuous dismissal this guard exists for).
		if paths, ok := sensitivityOnly(before, after, rc.Change.BeforeSensitive, rc.Change.AfterSensitive); ok {
			return verdict{Reason: ReasonSensitivityOnly, Attributes: paths}
		}
		tr, trKnown := traits[schemaKey{provider: rc.ProviderName, resourceType: rc.Type}]
		if paths, ok := schemaMarksOnly(before, after, rc.Change.BeforeSensitive, rc.Change.AfterSensitive, tr, trKnown); ok {
			return verdict{Reason: ReasonSensitivityOnly, Attributes: paths}
		}
		return asDrift
	}

	// Fail-closed on configuration: with no config section, or an address that does not
	// resolve to one, every attribute counts as declared and the config-aware tier never
	// fires. Missing evidence must never widen what we dismiss.
	declared, addrFound := cfg[tfaddr.ConfigAddress(rc.Address)]
	configKnown := cfg != nil && addrFound

	// Fail-closed on the provider schema, identically: no schema document, a provider we
	// have no schema for, or a resource type absent from it, and the schema-aware tier
	// never fires. Every existing caller that passes no schema therefore reaches exactly
	// the verdicts it reached before — which is what keeps the azure fixture pinned.
	attrSchema, typeFound := schemas[schemaKey{provider: rc.ProviderName, resourceType: rc.Type}]
	ev := evidence{
		declared:     declared,
		configKnown:  configKnown,
		attrSchema:   attrSchema,
		schemaKnown:  schemas != nil && typeFound,
		backRefs:     backReferenceRoots(rc, before, after, st),
		inapplicable: awsInapplicableRoots(rc, before, after),
	}

	// Every differing leaf path, computed BEFORE the dismissal loop so the drift branch can
	// name them too. A resource that stays drift is the case somebody has to diagnose, and
	// naming only the resource makes that a cloud round-trip (#2503): the addresses were
	// known and the attributes were not, so "provider hydration" stayed a hypothesis.
	all := make([]string, 0, len(leaves))
	for _, d := range leaves {
		all = append(all, d.path)
	}
	sort.Strings(all)
	asDrift.Attributes = all

	// Report the WEAKEST justification used, not the strongest: a resource dismissed
	// partly on the config-aware tier is recorded as such, so the audit trail never
	// overstates how firm the dismissal was.
	reason := ReasonEmptyCollection
	attrs := make([]string, 0, len(leaves))
	for _, d := range leaves {
		r, ok := d.normalizing(ev)
		if !ok {
			return asDrift
		}
		if reasonStrength(r) < reasonStrength(reason) {
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
//
// Tier 3 — a top-level attribute the PROVIDER SCHEMA marks `Computed && !Optional &&
// !Required`, not sensitive. That predicate is the whole tier, and it is deliberately the
// narrowest reading of "computed" the schema admits:
//
//   - Required means configuration MUST set it. Never dismissed.
//   - Optional means configuration MAY set it. Optional+Computed — `tags`,
//     `min_tls_version`, `public_network_access_enabled` — is the overwhelmingly common
//     shape, and it is exactly the shape an out-of-band scalar flip takes. Never
//     dismissed. Dismissing it would silence what this package exists to surface.
//   - Computed alone means there is NO config path into the attribute at all. The
//     provider fills it from the API on every Read: `google_storage_bucket.updated`,
//     an ARN, a self_link, a generation counter.
//
// Why it cannot hide a real out-of-band change: "out-of-band" is a claim about
// DIVERGENCE FROM INTENT, and an attribute no configuration can express carries no
// intent to diverge from. Nobody — operator or attacker — can set `updated` to a chosen
// value; it is a fact the API reports about the object, not a knob on it. And the
// converse matters more: because a refresh-only plan never applies, a computed-only
// attribute that differs once differs FOREVER. It is not a signal that decays, it is a
// stuck bit that makes the whole posture unreadable (#3099 — every gcp cell red on one
// timestamp). A detector that is permanently wrong on an unactionable field is how the
// actionable fields stop being read.
//
// The narrowings that remain load-bearing: not sensitive (a computed SECRET rotating —
// a generated password, a CA key — is precisely the event to surface, and both the plan's
// sensitivity mask and the schema's own Sensitive flag veto the dismissal); depth 0, the
// same limitation Tier 2 states, because nested attributes need block-order
// reconciliation this does not attempt — the motivating attribute is depth 0.
//
// Unlike Tiers 1 and 2 this tier does NOT constrain the delta's shape: any change to a
// computed-only attribute qualifies, in either direction, scalar or collection. That is
// the point — a timestamp advancing is a scalar delta with both sides non-null, which
// neither earlier tier can express.
func (d leafDelta) normalizing(ev evidence) (NormalizedReason, bool) {
	beforeNull := !d.beforeSet || d.before == nil
	afterNull := !d.afterSet || d.after == nil

	// The inapplicable-field and back-reference tiers are tried FIRST, weakest first, because a
	// leaf that could be dismissed more than one way must carry the weaker one. Their roots are
	// verified per resource (awsInapplicableRoots, backReferenceRoots), so these are lookups,
	// not judgements.
	if _, ok := ev.inapplicable[d.root]; ok && !d.sensitive {
		return ReasonInapplicableField, true
	}
	if _, ok := ev.backRefs[d.root]; ok && !d.sensitive {
		return ReasonAssignmentBackReference, true
	}

	// Tier 1, both directions. tags {"a":"b"} -> {} is tags REMOVED out-of-band and must
	// stay drift, so only the null side may be empty-or-absent — never both sides
	// flattened to ∅ before comparing, which is how detection of sweep-handle removal
	// would be lost.
	if (beforeNull && emptyCollection(d.after)) || (afterNull && emptyCollection(d.before)) {
		return ReasonEmptyCollection, true
	}

	// Tier 2 is tried before Tier 3 even though Tier 3 is the firmer rule, and
	// deliberately so. The two OVERLAP: an attribute with no config path into it is
	// necessarily undeclared, so a computed-only collection materialising from null
	// qualifies under both. Where a leaf could be dismissed either way the audit record
	// must carry the WEAKER justification — the same rule examine applies across leaves,
	// applied here within one.
	if r, ok := d.undeclaredCollection(ev, beforeNull); ok {
		return r, true
	}
	return d.computedOnly(ev)
}

// undeclaredCollection is Tier 2's predicate. beforeNull is passed rather than recomputed
// so the two callers cannot drift apart on what "null" means.
func (d leafDelta) undeclaredCollection(ev evidence, beforeNull bool) (NormalizedReason, bool) {
	switch {
	case !ev.configKnown, d.depth != 0, d.sensitive, !beforeNull, !isCollection(d.after):
		return "", false
	}
	if _, ok := ev.declared[d.root]; ok {
		return "", false
	}
	return ReasonUndeclaredCollection, true
}

// computedOnly is Tier 3's predicate, kept as its own function so the three schema flags
// read as one expression rather than as clauses in a longer switch.
func (d leafDelta) computedOnly(ev evidence) (NormalizedReason, bool) {
	if !ev.schemaKnown || d.depth != 0 || d.sensitive {
		return "", false
	}
	attr, ok := ev.attrSchema[d.root]
	if !ok || attr == nil {
		return "", false
	}
	if attr.Sensitive {
		return "", false
	}
	// The predicate, verbatim and positive: computed, and settable from configuration by
	// neither route.
	if attr.Computed && !attr.Optional && !attr.Required {
		return ReasonComputedAttribute, true
	}
	return "", false
}

// evidence is what one resource's dismissal tiers are allowed to consult, threaded from
// Analyze through examine so no tier can reach for anything examine did not resolve.
//
// Both *Known flags exist for the same reason and behave identically: missing evidence
// must never WIDEN what we dismiss. A tier whose evidence is absent does not guess and
// does not fall back to a laxer rule — it simply does not fire, and the delta stays drift.
type evidence struct {
	// declared is the set of top-level attribute names this resource's configuration
	// declares. Meaningful only when configKnown.
	declared map[string]struct{}
	// configKnown is true when the plan carried a configuration section AND this
	// resource's address resolved inside it.
	configKnown bool
	// attrSchema is the provider's top-level attribute schema for this resource type.
	// Meaningful only when schemaKnown.
	attrSchema map[string]*tfjson.SchemaAttribute
	// schemaKnown is true when a provider-schema document was supplied AND it covered
	// this resource's provider and type.
	schemaKnown bool
	// backRefs is the set of top-level attributes whose whole delta backReferenceRoots
	// verified as an assignment back-reference. Nil — the tier does not fire — without a
	// prior_state, or for any resource that tier does not recognise.
	backRefs map[string]struct{}
	// inapplicable is the set of top-level attributes whose whole delta awsInapplicableRoots
	// verified as a null -> 0 move of a field the API ignores for that element. Nil for any
	// resource that tier does not recognise.
	inapplicable map[string]struct{}
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

// maskMarks reports whether a sensitivity mask marks this position or ANY position beneath
// it. A `true` anywhere inside marks the whole position — conservative by design, since the
// cost of over-marking is a retained drift entry and the cost of under-marking is a
// dismissed secret.
//
// What it must NOT read as a mark is the mask's STRUCTURE. OpenTofu's plan JSON
// (jsonstate.SensitiveAsBoolWithPathValueMarks) keeps one slot per element of every list and
// set, rendering an unmarked primitive element as `false` and an unmarked object element as
// `{}`: a firewall with four apply_to blocks has the mask `"apply_to": [{}, {}, {}, {}]` and
// not a single sensitive value in it. Until #845's run 36706419571 this function counted any
// non-empty container as a mark, so every non-empty list attribute on every provider read as
// sensitive and was undismissable by every tier that respects sensitivity — which is why the
// hetzner firewall's apply_to back-reference never fired against real plan JSON, while the
// hand-written fixture (mask `{}`) passed. Only `true` is a mark.
func maskMarks(mask any) bool {
	switch v := mask.(type) {
	case bool:
		return v
	case map[string]any:
		for _, e := range v {
			if maskMarks(e) {
				return true
			}
		}
		return false
	case []any:
		for _, e := range v {
			if maskMarks(e) {
				return true
			}
		}
		return false
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

// schemaKey identifies one resource schema. Keyed on the provider SOURCE ADDRESS as well
// as the type — `registry.terraform.io/hashicorp/google` + `google_storage_bucket` —
// because a resource type name is only conventionally provider-unique, and a mirror or a
// fork can publish the same type name with different flags. ResourceChange.ProviderName
// carries the same fully-qualified address the schema document is keyed by, so this is a
// lookup rather than an inference.
type schemaKey struct {
	provider     string
	resourceType string
}

// schemaIndex maps a resource schema to its TOP-LEVEL attributes. Nested blocks are
// deliberately not indexed: the schema-aware tier is depth-0 only, so indexing deeper
// would build a structure nothing may read.
type schemaIndex map[schemaKey]map[string]*tfjson.SchemaAttribute

// indexSchemas flattens a `providers schema -json` document into the lookup examine
// needs. Returns nil when no schema document was supplied or it carries no providers,
// which callers treat as "no schema evidence" — the schema-aware tier then never fires,
// rather than guessing at which attributes are computed.
//
// The document is large (hundreds of MB on azurerm) but this index is not: it holds one
// pointer per top-level attribute of each resource type, into memory the decoder already
// allocated.
func indexSchemas(doc *tfjson.ProviderSchemas) schemaIndex {
	if doc == nil || len(doc.Schemas) == 0 {
		return nil
	}
	out := schemaIndex{}
	for provider, ps := range doc.Schemas {
		if ps == nil {
			continue
		}
		for typ, sch := range ps.ResourceSchemas {
			if sch == nil || sch.Block == nil || len(sch.Block.Attributes) == 0 {
				continue
			}
			out[schemaKey{provider: provider, resourceType: typ}] = sch.Block.Attributes
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// schemaTraits are the two whole-schema facts the schema-mark branch of the sensitivity
// tier needs (marks.go, schemaMarksOnly), found anywhere in a resource type's schema: in a
// top-level attribute, a nested attribute type, or a nested block, at any depth.
type schemaTraits struct {
	// sensitive: the schema declares at least one Sensitive attribute, so OpenTofu's
	// schema.ValueMarks can put a mark on this type's values.
	sensitive bool
	// dynamic: some attribute is typed with DynamicPseudoType (`any`). Its values carry
	// their own type, and two different types can encode to the same JSON, so equal JSON
	// no longer proves equal values.
	dynamic bool
}

// traitIndex maps a resource schema to its traits.
type traitIndex map[schemaKey]schemaTraits

// indexSchemaTraits computes schemaTraits for every resource type in a
// `providers schema -json` document. Returns nil for no document, which the schema-mark
// branch treats as no evidence: it never fires.
func indexSchemaTraits(doc *tfjson.ProviderSchemas) traitIndex {
	if doc == nil || len(doc.Schemas) == 0 {
		return nil
	}
	out := traitIndex{}
	for provider, ps := range doc.Schemas {
		if ps == nil {
			continue
		}
		for typ, sch := range ps.ResourceSchemas {
			if sch == nil || sch.Block == nil {
				continue
			}
			out[schemaKey{provider: provider, resourceType: typ}] = blockTraits(sch.Block)
		}
	}
	return out
}

// blockTraits folds the traits of every attribute and nested block in b.
func blockTraits(b *tfjson.SchemaBlock) schemaTraits {
	var t schemaTraits
	if b == nil {
		return t
	}
	for _, a := range b.Attributes {
		t = t.or(attrTraits(a))
	}
	for _, nb := range b.NestedBlocks {
		if nb != nil {
			t = t.or(blockTraits(nb.Block))
		}
	}
	return t
}

// attrTraits reports one attribute's traits, descending a nested attribute type. An
// attribute the document describes with neither a type nor a nested type is read as
// dynamic, so a shape this does not recognise can only keep a resource as drift.
func attrTraits(a *tfjson.SchemaAttribute) schemaTraits {
	if a == nil {
		return schemaTraits{}
	}
	t := schemaTraits{sensitive: a.Sensitive}
	switch {
	case a.AttributeNestedType != nil:
		for _, na := range a.AttributeNestedType.Attributes {
			t = t.or(attrTraits(na))
		}
	case a.AttributeType == cty.NilType, a.AttributeType.HasDynamicTypes():
		t.dynamic = true
	}
	return t
}

// or is the union of two trait sets.
func (t schemaTraits) or(u schemaTraits) schemaTraits {
	return schemaTraits{sensitive: t.sensitive || u.sensitive, dynamic: t.dynamic || u.dynamic}
}
