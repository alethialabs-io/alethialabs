// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
)

// FieldChange is one field the file declares whose value differs from the server's. `From` is
// nil when the server holds no value for the field (absent or null).
type FieldChange struct {
	Field string `json:"field"`
	From  any    `json:"from"`
	To    any    `json:"to"`
}

// diffFields compares the fields a file DECLARES with the values the server holds, and returns one
// change per declared field whose value differs, sorted by field name.
//
// Only `declared`'s keys are read. A field the file omits is not a change — omission means "leave
// it as it is", never "clear it" — so a file that names one field of a database cannot reset the
// others. Values compare by meaning rather than by Go type: YAML decodes `2` as an int and JSON
// decodes it as a float64, so numbers compare by value, and lists and maps compare structurally.
//
// It is deliberately independent of component kinds: it takes two plain maps, so any other part
// of the manifest with server-held values (add-ons, say) can reuse it.
func diffFields(declared, current map[string]any) []FieldChange {
	var out []FieldChange
	for field, want := range declared {
		have := current[field]
		if valuesEqual(want, have) {
			continue
		}
		out = append(out, FieldChange{Field: field, From: have, To: want})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Field < out[j].Field })
	return out
}

// valuesEqual reports whether two decoded values mean the same thing (see diffFields).
func valuesEqual(a, b any) bool {
	return reflect.DeepEqual(canonicalValue(a), canonicalValue(b))
}

// canonicalValue rewrites a decoded YAML or JSON value into one comparable form: every number
// becomes a float64, every map a map[string]any, every list a []any. Anything else is passed
// through a JSON round trip, so a type this function does not name still compares by its JSON
// meaning rather than by its Go type.
func canonicalValue(v any) any {
	switch t := v.(type) {
	case nil, bool, string, float64:
		return t
	case int:
		return float64(t)
	case int8:
		return float64(t)
	case int16:
		return float64(t)
	case int32:
		return float64(t)
	case int64:
		return float64(t)
	case uint:
		return float64(t)
	case uint8:
		return float64(t)
	case uint16:
		return float64(t)
	case uint32:
		return float64(t)
	case uint64:
		return float64(t)
	case float32:
		return float64(t)
	case json.Number:
		if f, err := t.Float64(); err == nil {
			return f
		}
		return t.String()
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, val := range t {
			out[k] = canonicalValue(val)
		}
		return out
	case map[any]any:
		out := make(map[string]any, len(t))
		for k, val := range t {
			out[fmt.Sprint(k)] = canonicalValue(val)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, val := range t {
			out[i] = canonicalValue(val)
		}
		return out
	}
	raw, err := json.Marshal(v)
	if err != nil {
		return v
	}
	var decoded any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return v
	}
	return canonicalValue(decoded)
}

// formatFieldValue renders one side of a change for a person: a string bare (quoted when empty,
// so it is visible), no value as `(unset)`, and anything else as compact JSON.
func formatFieldValue(v any) string {
	switch t := v.(type) {
	case nil:
		return "(unset)"
	case string:
		if t == "" {
			return `""`
		}
		return t
	}
	raw, err := json.Marshal(canonicalValue(v))
	if err != nil {
		return fmt.Sprint(v)
	}
	return string(raw)
}

// changedFields is the request body of an update: the file's value for each changed field.
func changedFields(changes []FieldChange) map[string]any {
	out := make(map[string]any, len(changes))
	for _, c := range changes {
		out[c.Field] = c.To
	}
	return out
}
