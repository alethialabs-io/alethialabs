// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

// What a PLAN job persists of `tofu show -json` into execution_metadata.plan_result. The plan
// document carries far more than its readers use, so the runner keeps only what they read:
//
//   - every reader needs each resource's identity and its actions (the plan summary's counts, the
//     CLI's summary line, the BYO-IaC canvas inventory, the approval page);
//   - the plan review (lib/plan/parse-plan.ts) also lists a few planned scalar values per resource,
//     marking unknown ones "known after apply", and the plan audit (verify.Evaluate over the stored
//     result) reads planned values and their unknown mask.
//
// So an apply plan keeps `change.after` without any value OpenTofu marks sensitive and without any
// value unknown until apply, plus the `after_unknown` mask itself. `before` and every other field
// are dropped. A destroy plan keeps identity and actions only (destroyPlanChanges), because a
// teardown plans no values.

// planChangeIdentityKeys are the fields of a resource change that say which resource it is.
var planChangeIdentityKeys = []string{"address", "module_address", "mode", "type", "name", "index", "provider_name"}

// planChangeIdentity copies a resource change's identity fields into a new map.
func planChangeIdentity(rc map[string]any) map[string]any {
	kept := make(map[string]any, len(planChangeIdentityKeys)+1)
	for _, k := range planChangeIdentityKeys {
		if v, ok := rc[k]; ok {
			kept[k] = v
		}
	}
	return kept
}

// planChangeActions returns a resource change's actions (only its string entries), or an empty list.
func planChangeActions(rc map[string]any) []any {
	actions := []any{}
	change, ok := rc["change"].(map[string]any)
	if !ok {
		return actions
	}
	list, ok := change["actions"].([]any)
	if !ok {
		return actions
	}
	for _, a := range list {
		if s, ok := a.(string); ok {
			actions = append(actions, s)
		}
	}
	return actions
}

// applyPlanChanges reduces an apply plan's resource_changes to each resource's identity, its
// actions, its planned values minus every sensitive or unknown one, and the unknown mask.
func applyPlanChanges(raw any) []any {
	list, ok := raw.([]any)
	if !ok {
		return []any{}
	}
	out := make([]any, 0, len(list))
	for _, el := range list {
		rc, ok := el.(map[string]any)
		if !ok {
			continue
		}
		kept := planChangeIdentity(rc)
		change := map[string]any{"actions": planChangeActions(rc)}
		if c, ok := rc["change"].(map[string]any); ok {
			sensitive, unknown := c["after_sensitive"], c["after_unknown"]
			if after, ok := c["after"].(map[string]any); ok {
				if v, keep := plannedValue(after, sensitive, unknown); keep {
					change["after"] = v
				}
			}
			if mask, keep := boolMask(unknown); keep {
				change["after_unknown"] = mask
			}
		}
		kept["change"] = change
		out = append(out, kept)
	}
	return out
}

// plannedValue returns v without any part that the sensitive or unknown mask marks, and whether
// anything of v is kept. OpenTofu's masks mirror the value's shape: `true` marks the whole value,
// an object or array marks its members, and false or absent marks nothing. A mask whose shape does
// not match the value (an object mask over a scalar) drops the value rather than guess. A dropped
// array element becomes null, so the remaining elements keep their positions.
func plannedValue(v, sensitive, unknown any) (any, bool) {
	if marksAll(sensitive) || marksAll(unknown) {
		return nil, false
	}
	switch val := v.(type) {
	case map[string]any:
		if !maskFits[map[string]any](sensitive) || !maskFits[map[string]any](unknown) {
			return nil, false
		}
		out := make(map[string]any, len(val))
		for k, member := range val {
			if kept, ok := plannedValue(member, memberMask(sensitive, k), memberMask(unknown, k)); ok {
				out[k] = kept
			}
		}
		return out, true
	case []any:
		if !maskFits[[]any](sensitive) || !maskFits[[]any](unknown) {
			return nil, false
		}
		out := make([]any, len(val))
		for i, member := range val {
			if kept, ok := plannedValue(member, elementMask(sensitive, i), elementMask(unknown, i)); ok {
				out[i] = kept
			}
		}
		return out, true
	default:
		if !isEmptyMask(sensitive) || !isEmptyMask(unknown) {
			return nil, false
		}
		return v, true
	}
}

// marksAll reports whether a mask marks the whole value.
func marksAll(mask any) bool {
	b, ok := mask.(bool)
	return ok && b
}

// isEmptyMask reports whether a mask marks nothing: absent, null or false.
func isEmptyMask(mask any) bool {
	if mask == nil {
		return true
	}
	b, ok := mask.(bool)
	return ok && !b
}

// maskFits reports whether a mask is empty or has the container shape T of the value it covers.
func maskFits[T map[string]any | []any](mask any) bool {
	if isEmptyMask(mask) {
		return true
	}
	_, ok := mask.(T)
	return ok
}

// memberMask returns the part of an object mask that covers member k (nil when none).
func memberMask(mask any, k string) any {
	if m, ok := mask.(map[string]any); ok {
		return m[k]
	}
	return nil
}

// elementMask returns the part of an array mask that covers element i (nil when none).
func elementMask(mask any, i int) any {
	if a, ok := mask.([]any); ok && i < len(a) {
		return a[i]
	}
	return nil
}

// boolMask returns a copy of a mask that keeps only its shape and its booleans, and whether there is
// one. A mask carries no values, but the copy makes sure nothing else rides along with it.
func boolMask(mask any) (any, bool) {
	switch m := mask.(type) {
	case bool:
		return m, true
	case map[string]any:
		out := make(map[string]any, len(m))
		for k, v := range m {
			if kept, ok := boolMask(v); ok {
				out[k] = kept
			}
		}
		return out, true
	case []any:
		out := make([]any, len(m))
		for i, v := range m {
			if kept, ok := boolMask(v); ok {
				out[i] = kept
			}
		}
		return out, true
	default:
		return nil, false
	}
}

// noChangePlanResult is what a plan with no resource_changes key records: its format_version
// alone, which tells the console's plan summary that this is a plan with nothing to change.
func noChangePlanResult(planJSON map[string]any) map[string]any {
	out := map[string]any{}
	if v, ok := planJSON["format_version"].(string); ok {
		out["format_version"] = v
	}
	return out
}
