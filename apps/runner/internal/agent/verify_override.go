// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/verify"
)

// buildVerifyOverride converts a DEPLOY job's `verify_override` JSON payload into a
// verify.Override the provisioner gate understands. Returns nil when there is no
// waiver or it carries no controls (so the gate stays fail-closed by default).
// Authorization is the console's job (it sets `by` to the actor and persists the
// row only for principals allowed to deploy) — the runner just honours what was
// recorded.
func buildVerifyOverride(raw map[string]any) *verify.Override {
	if len(raw) == 0 {
		return nil
	}
	controls := toStringSlice(raw["controls"])
	if len(controls) == 0 {
		return nil
	}
	ov := &verify.Override{
		Controls: controls,
		Reason:   asString(raw["reason"]),
		By:       asString(raw["by"]),
	}
	if exp := asString(raw["expiry"]); exp != "" {
		if t, err := time.Parse(time.RFC3339, exp); err == nil {
			ov.Expiry = t
		}
	}
	return ov
}

// toStringSlice coerces a JSON array (or single string) of control ids to []string.
func toStringSlice(v any) []string {
	switch t := v.(type) {
	case []any:
		out := make([]string, 0, len(t))
		for _, e := range t {
			if s, ok := e.(string); ok && s != "" {
				out = append(out, s)
			}
		}
		return out
	case []string:
		return t
	case string:
		if t == "" {
			return nil
		}
		return []string{t}
	default:
		return nil
	}
}

// asString narrows an any to a string (empty when not a string).
func asString(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}
