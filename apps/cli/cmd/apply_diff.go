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
//
// Key is set for a field the server merges key by key (a component's `provider_config`, an
// add-on's `settings`): the change is to that one key of the field, and `To` nil removes the key.
type FieldChange struct {
	Field string `json:"field"`
	Key   string `json:"key,omitempty"`
	From  any    `json:"from"`
	To    any    `json:"to"`
}

// label is how a change is named to a person: `field`, or `field.key` for one key of a merged field.
func (c FieldChange) label() string {
	if c.Key != "" {
		return c.Field + "." + c.Key
	}
	return c.Field
}

// mergedFields are the component fields the server MERGES key by key rather than replacing whole
// (#5529): a key the request omits is kept, and a key sent as null is removed. Diffing one as a
// single value would show a standing change whenever the server holds a key the file does not
// declare (one set in the console's Advanced section, say), and applying it would send the file's
// map as though it were the whole of the field.
var mergedFields = map[string]bool{"provider_config": true}

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
//
// A field in mergedFields is compared KEY BY KEY, by the same rule one level down: a key the file
// does not declare is kept and is no change, and `key: null` is a change only while the server
// still holds the key — so a removal settles after one apply.
func diffFields(declared, current map[string]any) []FieldChange {
	var out []FieldChange
	for field, want := range declared {
		have := current[field]
		if mergedFields[field] {
			if wantKeys, ok := stringKeyed(want); ok {
				haveKeys, _ := stringKeyed(have)
				out = append(out, diffKeys(field, wantKeys, haveKeys)...)
				continue
			}
		}
		if valuesEqual(want, have) {
			continue
		}
		out = append(out, FieldChange{Field: field, From: have, To: want})
	}
	sortChanges(out)
	return out
}

// diffKeys compares the keys `declared` names with the same keys of `current`, as changes to one
// key of `field`. A declared null equals an absent key, so a removed key is a change exactly once.
func diffKeys(field string, declared, current map[string]any) []FieldChange {
	var out []FieldChange
	for key, want := range declared {
		have := current[key]
		if valuesEqual(want, have) {
			continue
		}
		out = append(out, FieldChange{Field: field, Key: key, From: have, To: want})
	}
	return out
}

// stringKeyed reads a decoded mapping — YAML's map[string]any or map[any]any, or JSON's — as a
// map[string]any, and reports whether v was a mapping at all.
func stringKeyed(v any) (map[string]any, bool) {
	switch t := v.(type) {
	case map[string]any:
		return t, true
	case map[any]any:
		out := make(map[string]any, len(t))
		for k, val := range t {
			out[fmt.Sprint(k)] = val
		}
		return out, true
	}
	return nil, false
}

// sortChanges orders changes by field, then key, so a plan reads the same on every run.
func sortChanges(out []FieldChange) {
	sort.Slice(out, func(i, j int) bool {
		if out[i].Field != out[j].Field {
			return out[i].Field < out[j].Field
		}
		return out[i].Key < out[j].Key
	})
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
	case nil, bool, string:
		return t
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
	// Every Go number kind, by kind rather than by a case per type: YAML hands back int, JSON
	// float64, and a caller building a map by hand may use any of the others.
	rv := reflect.ValueOf(v)
	switch {
	case rv.CanInt():
		return float64(rv.Int())
	case rv.CanUint():
		return float64(rv.Uint())
	case rv.CanFloat():
		return rv.Float()
	}
	raw, err := json.Marshal(v)
	if err != nil {
		// Not representable as JSON (a func, a channel): compared as itself, so it equals nothing
		// but an identical value.
		return v
	}
	// Bytes json.Marshal just produced always decode.
	var decoded any
	_ = json.Unmarshal(raw, &decoded)
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

// changedFields is the request body of an update: the file's value for each changed field. A change
// to one key of a merged field is sent as a mapping holding only the changed keys — the server
// merges it, so the keys left out are kept and a null removes its key.
func changedFields(changes []FieldChange) map[string]any {
	out := make(map[string]any, len(changes))
	for _, c := range changes {
		if c.Key == "" {
			out[c.Field] = c.To
			continue
		}
		keys, ok := out[c.Field].(map[string]any)
		if !ok {
			keys = map[string]any{}
			out[c.Field] = keys
		}
		keys[c.Key] = c.To
	}
	return out
}
