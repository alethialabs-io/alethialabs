// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import "fmt"

// pcString reads a string from a provider_config map (JSON-decoded), with a
// default. Tolerates non-string scalars by formatting them.
func pcString(pc map[string]any, key, def string) string {
	if pc == nil {
		return def
	}
	v, ok := pc[key]
	if !ok || v == nil {
		return def
	}
	if s, ok := v.(string); ok {
		if s == "" {
			return def
		}
		return s
	}
	return fmt.Sprintf("%v", v)
}

// pcBool reads a bool from a provider_config map, tolerating "true"/"false"
// strings (the form may serialize toggles either way).
func pcBool(pc map[string]any, key string, def bool) bool {
	if pc == nil {
		return def
	}
	v, ok := pc[key]
	if !ok || v == nil {
		return def
	}
	switch t := v.(type) {
	case bool:
		return t
	case string:
		return t == "true"
	default:
		return def
	}
}

// cred reads a decrypted credential field, with a default.
func cred(c map[string]string, key, def string) string {
	if c == nil {
		return def
	}
	if v, ok := c[key]; ok && v != "" {
		return v
	}
	return def
}

// itemNames returns the names of the component items (registry repos, secrets).
func itemNames(items []ComponentItem) []string {
	out := make([]string, 0, len(items))
	for _, it := range items {
		out = append(out, it.Name)
	}
	return out
}
