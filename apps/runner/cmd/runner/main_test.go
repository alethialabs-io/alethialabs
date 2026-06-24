// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package main

import "testing"

func TestRunnerSlots(t *testing.T) {
	cases := []struct {
		val  string
		want int
	}{
		{"", 1},    // unset → single slot (today's behavior)
		{"1", 1},   //
		{"4", 4},   //
		{" 3 ", 3}, // trimmed
		{"0", 1},   // invalid (<1) → clamp to 1
		{"-2", 1},  // negative → 1
		{"abc", 1}, // non-numeric → 1
		{"2.5", 1}, // not an int → 1
	}
	for _, c := range cases {
		t.Setenv("ALETHIA_RUNNER_SLOTS", c.val)
		if got := runnerSlots(); got != c.want {
			t.Errorf("runnerSlots(%q) = %d, want %d", c.val, got, c.want)
		}
	}
}
