// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"fmt"
	"reflect"
	"slices"
)

// reflectTypeOfInt is a Go type the generator has no schema for.
var reflectTypeOfInt = reflect.TypeOf(0)

// check validates a decoded YAML value against a schema and returns every problem it finds. It
// implements exactly the keywords the generator writes, so the tests can ask the question a YAML
// language server asks without a schema library in the module.
func check(s *Schema, v any, at string) []string {
	var problems []string
	if s.Type != nil && !typeMatches(s.Type, v) {
		return []string{fmt.Sprintf("%s: is %s, want %v", at, jsonType(v), s.Type)}
	}
	if len(s.Enum) > 0 && !slices.Contains(s.Enum, v) {
		problems = append(problems, fmt.Sprintf("%s: %v is not one of %v", at, v, s.Enum))
	}
	if len(s.OneOf) > 0 {
		matches := 0
		for _, alt := range s.OneOf {
			if len(check(alt, v, at)) == 0 {
				matches++
			}
		}
		if matches != 1 {
			problems = append(problems, fmt.Sprintf("%s: matches %d of the %d shapes, want exactly one", at, matches, len(s.OneOf)))
		}
	}
	switch value := v.(type) {
	case map[string]any:
		for _, name := range s.Required {
			if _, ok := value[name]; !ok {
				problems = append(problems, fmt.Sprintf("%s: %s is required", at, name))
			}
		}
		for key, item := range value {
			switch prop := s.Properties.Get(key); {
			case prop != nil:
				problems = append(problems, check(prop, item, at+"."+key)...)
			case s.AdditionalProperties == false:
				problems = append(problems, fmt.Sprintf("%s: %s is not a key here", at, key))
			default:
				if extra, ok := s.AdditionalProperties.(*Schema); ok {
					problems = append(problems, check(extra, item, at+"."+key)...)
				}
			}
		}
	case []any:
		if len(value) < s.MinItems {
			problems = append(problems, fmt.Sprintf("%s: has %d entries, want at least %d", at, len(value), s.MinItems))
		}
		if s.Items != nil {
			for i, item := range value {
				problems = append(problems, check(s.Items, item, fmt.Sprintf("%s[%d]", at, i))...)
			}
		}
	}
	return problems
}

// typeMatches reports whether v has the JSON type, or one of the JSON types, want names.
func typeMatches(want, v any) bool {
	got := jsonType(v)
	switch names := want.(type) {
	case string:
		return names == got
	case []string:
		return slices.Contains(names, got)
	}
	return false
}

// jsonType is the JSON Schema type name of a decoded YAML value.
func jsonType(v any) string {
	switch v.(type) {
	case nil:
		return "null"
	case string:
		return "string"
	case bool:
		return "boolean"
	case int, int64, uint64, float64:
		return "number"
	case []any:
		return "array"
	case map[string]any:
		return "object"
	}
	return fmt.Sprintf("%T", v)
}
