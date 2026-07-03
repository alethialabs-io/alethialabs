// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import "testing"

func TestBuildVerifyOverride_Full(t *testing.T) {
	ov := buildVerifyOverride(map[string]any{
		"controls": []any{"KEYLESS-001", "LEASTPRIV-001"},
		"reason":   "migration window",
		"by":       "secops@acme",
		"expiry":   "2026-07-01T00:00:00Z",
	})
	if ov == nil {
		t.Fatal("expected an override")
	}
	if len(ov.Controls) != 2 || ov.By != "secops@acme" || ov.Reason != "migration window" {
		t.Errorf("override not parsed faithfully: %+v", ov)
	}
	if ov.Expiry.IsZero() {
		t.Error("expiry should have parsed")
	}
}

func TestBuildVerifyOverride_NilAndEmpty(t *testing.T) {
	if buildVerifyOverride(nil) != nil {
		t.Error("nil payload → nil override")
	}
	if buildVerifyOverride(map[string]any{}) != nil {
		t.Error("empty payload → nil override")
	}
	if buildVerifyOverride(map[string]any{"reason": "x"}) != nil {
		t.Error("payload with no controls → nil override (gate stays fail-closed)")
	}
}

func TestBuildVerifyOverride_BadExpiryIgnored(t *testing.T) {
	ov := buildVerifyOverride(map[string]any{
		"controls": []any{"KEYLESS-001"},
		"expiry":   "not-a-date",
	})
	if ov == nil {
		t.Fatal("expected an override even with a bad expiry")
	}
	if !ov.Expiry.IsZero() {
		t.Error("an unparseable expiry should be left zero (treated as no expiry)")
	}
}
