// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package selfimage

import "testing"

func TestRef(t *testing.T) {
	cases := []struct {
		name     string
		override string
		baked    string
		want     string
	}{
		{
			name: "neither set — not derivable, and that is a real answer",
			want: "",
		},
		{
			name:  "baked only — the normal case for a published runner image",
			baked: "ghcr.io/alethialabs-io/runner-aws:abc123",
			want:  "ghcr.io/alethialabs-io/runner-aws:abc123",
		},
		{
			name:     "override only — an operator naming a mirror",
			override: "registry.internal/alethia/runner:abc123",
			want:     "registry.internal/alethia/runner:abc123",
		},
		{
			name:     "override WINS over baked — that is the point of the override",
			override: "registry.internal/alethia/runner:abc123",
			baked:    "ghcr.io/alethialabs-io/runner-aws:abc123",
			want:     "registry.internal/alethia/runner:abc123",
		},
		{
			// The build arg defaults to "", and a Dockerfile ENV of an empty arg still sets the
			// variable — to the empty string. If that counted as "set", the override would be
			// shadowed by nothing at all on every locally built image.
			name:     "an empty baked value does not shadow the override",
			override: "registry.internal/alethia/runner:abc123",
			baked:    "",
			want:     "registry.internal/alethia/runner:abc123",
		},
		{
			name:     "whitespace-only is not a reference",
			override: "   ",
			baked:    "\t\n",
			want:     "",
		},
		{
			name:     "a padded value is trimmed, not rejected",
			override: "  ghcr.io/alethialabs-io/runner:v1  ",
			want:     "ghcr.io/alethialabs-io/runner:v1",
		},
		{
			// Whitespace in the override must not fall through to a stale baked ref — silently
			// deploying a different image than the operator named is worse than refusing.
			name:     "a blank override falls back to baked rather than to nothing",
			override: "  ",
			baked:    "ghcr.io/alethialabs-io/runner-gcp:abc123",
			want:     "ghcr.io/alethialabs-io/runner-gcp:abc123",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv(EnvOverride, tc.override)
			t.Setenv(EnvBaked, tc.baked)
			if got := Ref(); got != tc.want {
				t.Fatalf("Ref() = %q, want %q", got, tc.want)
			}
		})
	}
}
