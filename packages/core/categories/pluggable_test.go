// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import "testing"

func TestIsPluggable(t *testing.T) {
	cases := map[string]bool{
		"":           false, // no provider chosen
		"native":     false, // the cloud-native backend
		"cloudflare": true,
		"vault":      true,
	}
	for slug, want := range cases {
		if got := IsPluggable(slug); got != want {
			t.Errorf("IsPluggable(%q) = %v, want %v", slug, got, want)
		}
	}
}

func TestGet_UnknownProviderErrors(t *testing.T) {
	if _, err := Get("dns", "definitely-not-a-real-provider"); err == nil {
		t.Error("expected an error for an unknown provider slug")
	}
}
