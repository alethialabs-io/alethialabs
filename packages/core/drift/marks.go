// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package drift

import (
	"sort"
	"strconv"
)

// sensitivityOnly decides the one drift shape with NO differing value: OpenTofu reported the
// resource as updated, yet before and after are equal attribute for attribute. It returns the
// attribute paths whose sensitivity MARK differs, and true, when that is provably the whole
// change.
//
// The shape it exists for, measured on hetzner (#845, run 36667774857; and the plain floor soak
// of 2026-08-25): talos_machine_secrets and talos_cluster_kubeconfig reported "has changed" on
// every refresh with "(N unchanged attributes hidden)" and no attribute at all. Both schemas
// carry SENSITIVE attributes NESTED inside computed nested objects (machine_secrets.certs.*.key,
// client_configuration.client_key, kubernetes_client_configuration.client_key). OpenTofu marks
// a planned value with the schema's sensitive paths while that value is still UNKNOWN, and a
// mark on a path beneath an unknown object has nothing to attach to — so the state the apply
// writes lacks the nested marks. Every refresh then re-marks the now-known value from the schema
// (OpenTofu v1.9 internal/tofu/node_resource_abstract_instance.go, refresh: combinePathValueMarks
// (priorPaths, schema.ValueMarks(...))), and the drift comparison (context_plan.go,
// driftedResources) is cty RawEquals, which compares marks. Equal values, different marks,
// reported as an update. A refresh-only plan never writes state, so it recurs forever.
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
//     changed. Two identical objects with identical masks are an unexplained report, and stay
//     drift — the vacuous dismissal the zero-leaf guard in examine exists to refuse.
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
