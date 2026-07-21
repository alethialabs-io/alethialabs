// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import "testing"

func TestShortID(t *testing.T) {
	cases := []struct {
		name string
		in   string
		n    int
		want string
	}{
		{"long truncates", "0123456789abcdef", 8, "01234567"},
		{"exact length", "01234567", 8, "01234567"},
		{"shorter than n returns whole (no panic)", "abc", 8, "abc"},
		{"empty", "", 8, ""},
		{"negative n returns whole", "abcdef", -1, "abcdef"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := shortID(tc.in, tc.n); got != tc.want {
				t.Fatalf("shortID(%q, %d) = %q, want %q", tc.in, tc.n, got, tc.want)
			}
		})
	}
}

func TestShortSHA12DelegatesToShortID(t *testing.T) {
	if got := shortSHA12("0123456789abcdef01"); got != "0123456789ab" {
		t.Fatalf("shortSHA12 = %q, want 0123456789ab", got)
	}
	if got := shortSHA12("short"); got != "short" {
		t.Fatalf("shortSHA12 on a short sha = %q, want short", got)
	}
}
