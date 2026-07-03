// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package state

import "testing"

func TestRawConfigFromFullConfig(t *testing.T) {
	if _, err := RawConfigFromFullConfig(nil); err == nil {
		t.Error("nil config should error")
	}
	empty := ""
	if _, err := RawConfigFromFullConfig(&empty); err == nil {
		t.Error("empty config should error")
	}
	bad := "{not valid json"
	if _, err := RawConfigFromFullConfig(&bad); err == nil {
		t.Error("malformed JSON should error")
	}

	good := `{"region":"eu-west-1","count":3}`
	m, err := RawConfigFromFullConfig(&good)
	if err != nil {
		t.Fatalf("valid JSON: %v", err)
	}
	if m["region"] != "eu-west-1" {
		t.Errorf("region = %v, want eu-west-1", m["region"])
	}
}
