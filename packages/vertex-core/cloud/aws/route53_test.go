// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package aws

import (
	"testing"
)

func TestHostedZoneInfoStructure(t *testing.T) {
	zone := HostedZoneInfo{
		ID:          "Z1234567890",
		Name:        "example.com",
		RecordCount: 42,
		IsPrivate:   false,
	}

	if zone.ID != "Z1234567890" {
		t.Errorf("unexpected ID: %s", zone.ID)
	}
	if zone.Name != "example.com" {
		t.Errorf("unexpected Name: %s", zone.Name)
	}
	if zone.RecordCount != 42 {
		t.Errorf("unexpected RecordCount: %d", zone.RecordCount)
	}
	if zone.IsPrivate {
		t.Error("expected public zone")
	}
}
