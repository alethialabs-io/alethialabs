// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package verify

import (
	"encoding/json"
	"slices"
	"strings"
)

// iamStatement is one statement of an AWS IAM policy document, decoded
// permissively because Terraform/OpenTofu serialise these fields as either a
// scalar or a list depending on author style.
type iamStatement struct {
	Effect    string
	Action    []string
	NotAction []string
	Resource  []string
	Principal map[string]any
	Condition map[string]any
}

// iamDoc is a parsed IAM policy document.
type iamDoc struct {
	Statements []iamStatement
}

// asObject narrows an arbitrary JSON value to an object.
func asObject(v any) (map[string]any, bool) {
	m, ok := v.(map[string]any)
	return m, ok
}

// toStringSlice coerces an IAM field that may be a string or a []string (or
// absent) into a []string. Numbers/bools are stringified defensively.
func toStringSlice(v any) []string {
	switch t := v.(type) {
	case nil:
		return nil
	case string:
		return []string{t}
	case []any:
		out := make([]string, 0, len(t))
		for _, e := range t {
			if s, ok := e.(string); ok {
				out = append(out, s)
			}
		}
		return out
	case []string:
		return t
	default:
		return nil
	}
}

// attrUnknown reports whether attribute `key` of a resource is computed/unknown
// until apply, per the plan's `after_unknown` object. Such attributes cannot be
// inspected, so controls that depend on them must return not_evaluable rather
// than silently passing.
func attrUnknown(afterUnknown any, key string) bool {
	m, ok := asObject(afterUnknown)
	if !ok {
		return false
	}
	switch t := m[key].(type) {
	case bool:
		return t
	case map[string]any, []any:
		// A nested unknown structure also means "not fully known".
		return true
	default:
		return false
	}
}

// parseIAMPolicy extracts and parses an IAM policy document held in attribute
// `key` of `after`. It returns:
//   - doc:       the parsed document (nil if absent/unparseable)
//   - present:   whether the attribute exists in `after` at all
//   - evaluable: whether the body is known well enough to judge. A value that is
//     unknown-until-apply, or present only as an opaque/unparseable blob, is NOT
//     evaluable — the caller must surface not_evaluable, never a silent pass.
func parseIAMPolicy(after map[string]any, afterUnknown any, key string) (doc *iamDoc, present, evaluable bool) {
	if attrUnknown(afterUnknown, key) {
		// Attribute exists in the resource schema but its value is computed.
		return nil, true, false
	}
	raw, ok := after[key]
	if !ok || raw == nil {
		return nil, false, false
	}
	present = true

	var root map[string]any
	switch t := raw.(type) {
	case string:
		if strings.TrimSpace(t) == "" {
			return nil, true, false
		}
		if err := json.Unmarshal([]byte(t), &root); err != nil {
			// A non-JSON string body we cannot inspect — explicitly not evaluable.
			return nil, true, false
		}
	case map[string]any:
		root = t
	default:
		return nil, true, false
	}

	parsed := &iamDoc{}
	for _, st := range extractStatements(root["Statement"]) {
		stmt := iamStatement{
			Effect:    asString(st["Effect"]),
			Action:    toStringSlice(st["Action"]),
			NotAction: toStringSlice(st["NotAction"]),
			Resource:  toStringSlice(st["Resource"]),
		}
		if p, ok := asObject(st["Principal"]); ok {
			stmt.Principal = p
		}
		if c, ok := asObject(st["Condition"]); ok {
			stmt.Condition = c
		}
		parsed.Statements = append(parsed.Statements, stmt)
	}
	return parsed, present, true
}

// extractStatements normalises the IAM `Statement` field, which may be a single
// statement object or an array of them.
func extractStatements(v any) []map[string]any {
	switch t := v.(type) {
	case map[string]any:
		return []map[string]any{t}
	case []any:
		out := make([]map[string]any, 0, len(t))
		for _, e := range t {
			if m, ok := asObject(e); ok {
				out = append(out, m)
			}
		}
		return out
	default:
		return nil
	}
}

func asString(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

// hasWildcard reports whether any element is exactly "*".
func hasWildcard(xs []string) bool {
	return slices.Contains(xs, "*")
}

// sensitiveServiceWildcards returns service-scoped wildcards on high-blast-radius
// services (e.g. "iam:*", "kms:*"). These are not the literal "*" admin grant but
// are broad enough to flag.
func sensitiveServiceWildcards(actions []string) []string {
	sensitive := map[string]bool{"iam": true, "kms": true, "sts": true, "secretsmanager": true, "organizations": true}
	var hits []string
	for _, a := range actions {
		if !strings.HasSuffix(a, ":*") {
			continue
		}
		svc := strings.ToLower(strings.TrimSuffix(a, ":*"))
		if sensitive[svc] {
			hits = append(hits, a)
		}
	}
	return hits
}
