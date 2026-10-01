// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package drift

import (
	"sort"
	"strconv"
)

// sensitivityOnly decides the drift shape with NO differing value whose sensitivity masks, as
// the plan JSON prints them, DIFFER. It returns the attribute paths whose mark differs, and
// true, when that is provably the whole change.
//
// Under OpenTofu v1.9 (the runner's pinned version) a refresh-only plan cannot print this shape:
// refresh re-marks the value as prior marks ∪ schema marks (internal/tofu/
// node_resource_abstract_instance.go, refresh: combinePathValueMarks(priorPaths,
// schema.ValueMarks(...))), and jsonplan adds the same schema marks to BOTH sides before
// printing (internal/command/jsonplan/plan.go, marshalResourceChange), so a marks-only drift
// prints two identical masks. That case is schemaMarksOnly's, and #845 run 36706419571 is the
// measurement that showed it: talos_machine_secrets and talos_cluster_kubeconfig stayed drift
// with no attribute named, because this function — built on masks RECONSTRUCTED on the
// assumption they would differ — found them equal. This branch stays for a mark difference the
// schema does not explain (a sensitive input variable flowing into state), which it proves the
// same way.
//
// WHY THIS CANNOT HIDE A REAL CHANGE. A mark is not a property of the infrastructure: it is
// OpenTofu's note of which paths to redact when rendering. The dismissal requires, all at once:
//
//   - before and after are both non-empty objects and DEEPLY EQUAL (the caller found zero
//     differing leaves). Both are decoded by OpenTofu against the same schema type, so equal
//     JSON means equal cty values;
//   - NEITHER side contains a NUMBER anywhere. Plan JSON is decoded with numbers as float64
//     (terraform-exec does not opt into json.Number for plans), and two distinct numbers can
//     round to one float64 — so for a value holding a number, "equal JSON" would not prove
//     "equal value". Strings, bools and nulls decode losslessly, so without numbers it does;
//   - the sensitivity masks DIFFER, on at least one path. That is positive evidence of what
//     changed. Two identical objects with identical masks are an unexplained report here, and
//     reach schemaMarksOnly, which needs the provider schema to explain them.
//
// Nothing here consults sensitivity to WEAKEN a check elsewhere: a sensitive leaf whose value
// changes is a differing leaf, never reaches this function, and remains undismissable by every
// config- and schema-aware tier.
func sensitivityOnly(before, after map[string]any, beforeSens, afterSens any) ([]string, bool) {
	if len(before) == 0 || len(after) == 0 {
		return nil, false
	}
	if containsNumber(before) || containsNumber(after) {
		return nil, false
	}
	b := map[string]struct{}{}
	a := map[string]struct{}{}
	markedPaths(beforeSens, "", b)
	markedPaths(afterSens, "", a)
	var diff []string
	for p := range b {
		if _, ok := a[p]; !ok {
			diff = append(diff, p)
		}
	}
	for p := range a {
		if _, ok := b[p]; !ok {
			diff = append(diff, p)
		}
	}
	if len(diff) == 0 {
		return nil, false
	}
	sort.Strings(diff)
	return diff, true
}

// schemaMarksOnly decides the no-differing-value drift whose printed masks are EQUAL — the shape
// #845 run 36706419571 measured on talos_machine_secrets and talos_cluster_kubeconfig on every
// hetzner Fabric: "has changed", "(N unchanged attributes hidden)", no attribute. It returns the
// marked paths the difference must lie among, and true, when a schema-declared mark is provably
// the whole change.
//
// The argument, from OpenTofu v1.9.0's source, one step at a time:
//
//  1. The resource is in resource_drift as an update, so its recorded and refreshed values are
//     NOT RawEqual (internal/tofu/context_plan.go, driftedResources). RawEquals compares values
//     AND marks.
//  2. The printed values are equal and, by the guards below, that proves the unmarked values are
//     equal. So the marks differ. The only mark a resource's state carries is Sensitive.
//  3. Refresh sets the new marks to (recorded marks ∪ S), S being the paths the provider schema
//     declares sensitive (combinePathValueMarks(priorPaths, schema.ValueMarks(...))). So the
//     difference is S minus the recorded marks: the recorded state lacks marks the schema
//     already declares. (How the apply came to write them without those marks is not needed for
//     the argument; the nested-sensitive-attribute shape the talos schemas share is the likely
//     cause.)
//  4. jsonplan prints each side's marks ∪ S, which is why the two masks print identical and
//     sensitivityOnly cannot see it. The masks' marked paths are therefore a superset of where
//     the difference lies, and they are what is recorded — paths, never values.
//
// So a dismissed resource says: every value is what it was, and OpenTofu now redacts, on its
// own schema's say-so, a path it had not redacted before. No infrastructure fact differs.
//
// Each guard is load-bearing and fails closed:
//
//   - known: the provider schema document covers this provider and type. Without it none of
//     S, and none of the dynamic check, is known.
//   - traits.sensitive: the schema declares a sensitive attribute somewhere. With S empty,
//     refresh adds no mark (step 3) and equal printed masks mean equal marks, so the update
//     is unexplained and stays drift.
//   - !traits.dynamic: a dynamically-typed attribute carries its own type, and a list, set and
//     tuple of the same elements print the same JSON — equal JSON would not prove step 2.
//   - both objects non-empty, and no NUMBER on either side, for the reasons sensitivityOnly
//     gives.
//   - the masks mark the SAME, NON-EMPTY path set. A mask that differs is sensitivityOnly's
//     case, not this one; an empty one means S marked nothing on this value, so step 3 has no
//     room for the difference.
//
// The argument is OpenTofu's refresh and jsonplan behaviour, pinned at v1.9.0 in
// apps/runner/Dockerfile.base. A later OpenTofu that printed the unions differently would move
// the shape back to sensitivityOnly or to drift — never silently wider.
func schemaMarksOnly(before, after map[string]any, beforeSens, afterSens any, traits schemaTraits, known bool) ([]string, bool) {
	if !known || !traits.sensitive || traits.dynamic {
		return nil, false
	}
	if len(before) == 0 || len(after) == 0 || containsNumber(before) || containsNumber(after) {
		return nil, false
	}
	b := map[string]struct{}{}
	a := map[string]struct{}{}
	markedPaths(beforeSens, "", b)
	markedPaths(afterSens, "", a)
	if len(a) == 0 || len(a) != len(b) {
		return nil, false
	}
	paths := make([]string, 0, len(a))
	for p := range a {
		if _, ok := b[p]; !ok {
			return nil, false
		}
		paths = append(paths, p)
	}
	sort.Strings(paths)
	return paths, true
}

// markedPaths collects every path a sensitivity mask marks true, in the same path syntax as
// leafDelta.path ("a.b", "list[0].x"). The mask mirrors the value's structure with sensitive
// positions replaced by true; false, empty containers and non-mask shapes mark nothing.
func markedPaths(mask any, prefix string, out map[string]struct{}) {
	switch m := mask.(type) {
	case bool:
		if m {
			if prefix == "" {
				// The whole object marked sensitive.
				out["."] = struct{}{}
			} else {
				out[prefix] = struct{}{}
			}
		}
	case map[string]any:
		for k, v := range m {
			p := k
			if prefix != "" {
				p = prefix + "." + k
			}
			markedPaths(v, p, out)
		}
	case []any:
		for i, v := range m {
			markedPaths(v, prefix+"["+strconv.Itoa(i)+"]", out)
		}
	}
}

// containsNumber reports whether v holds a number anywhere — float64 or any other decoded
// numeric form (json.Number) — at any depth.
func containsNumber(v any) bool {
	switch t := v.(type) {
	case nil, string, bool:
		return false
	case map[string]any:
		for _, e := range t {
			if containsNumber(e) {
				return true
			}
		}
		return false
	case []any:
		for _, e := range t {
			if containsNumber(e) {
				return true
			}
		}
		return false
	default:
		// float64, json.Number, and any shape not listed above: treated as a number, so an
		// unrecognised type can only keep a resource as drift, never dismiss it.
		return true
	}
}
