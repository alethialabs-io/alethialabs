// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package tofu

import "testing"

func TestResolvedIaCVersion(t *testing.T) {
	t.Run("defaults when unset", func(t *testing.T) {
		t.Setenv(IaCVersionEnv, "")
		if got := ResolvedIaCVersion(); got != DefaultIaCVersion {
			t.Fatalf("ResolvedIaCVersion() = %q, want default %q", got, DefaultIaCVersion)
		}
	})
	t.Run("honors the override", func(t *testing.T) {
		t.Setenv(IaCVersionEnv, "1.7.3")
		if got := ResolvedIaCVersion(); got != "1.7.3" {
			t.Fatalf("ResolvedIaCVersion() = %q, want 1.7.3", got)
		}
	})
	t.Run("trims whitespace", func(t *testing.T) {
		t.Setenv(IaCVersionEnv, "  1.8.0\n")
		if got := ResolvedIaCVersion(); got != "1.8.0" {
			t.Fatalf("ResolvedIaCVersion() = %q, want 1.8.0", got)
		}
	})
}
