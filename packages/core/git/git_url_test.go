// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package git

import "testing"

// TestTransformURLToHTTPS pins the token-clone URL normalization. The load-bearing case
// is the regression: a full ssh:// URL must NOT be re-prefixed into "https://ssh://…"
// (which broke token clones of validateByoRepoURL-accepted ssh:// BYO repos).
func TestTransformURLToHTTPS(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		// Regression: full ssh:// URL → rewritten to https (host+path), NOT mangled.
		{"ssh scheme rewritten to https", "ssh://git@github.com/owner/repo.git", "https://github.com/owner/repo.git"},
		{"ssh scheme with port drops port", "ssh://git@github.com:22/owner/repo.git", "https://github.com/owner/repo.git"},
		{"scp-like shorthand", "git@github.com:owner/repo.git", "https://github.com/owner/repo.git"},
		{"already https untouched", "https://github.com/owner/repo.git", "https://github.com/owner/repo.git"},
		{"http untouched", "http://internal.example/repo.git", "http://internal.example/repo.git"},
		{"file transport untouched", "file:///tmp/repo", "file:///tmp/repo"},
		{"other scheme not re-prefixed", "git://github.com/owner/repo.git", "git://github.com/owner/repo.git"},
		{"bare host/path assumes https", "github.com/owner/repo.git", "https://github.com/owner/repo.git"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := transformURLToHTTPS(tc.in); got != tc.want {
				t.Fatalf("transformURLToHTTPS(%q) = %q, want %q", tc.in, got, tc.want)
			}
			// The specific bug: the output must never contain a doubled scheme.
			if got := transformURLToHTTPS(tc.in); got == "https://"+tc.in && tc.in != "github.com/owner/repo.git" {
				t.Fatalf("transformURLToHTTPS(%q) re-prefixed a scheme'd URL: %q", tc.in, got)
			}
		})
	}
}

// TestNewGITWithTokenSSHURL confirms the constructor path (token auth) normalizes a full
// ssh:// URL to https so BasicAuth token clones work — the end-to-end guard for the fix.
func TestNewGITWithTokenSSHURL(t *testing.T) {
	g := NewGITWithToken("ssh://git@github.com/owner/repo.git", "/tmp/x", false, "tok")
	if g.RepoURL != "https://github.com/owner/repo.git" {
		t.Fatalf("RepoURL = %q, want https://github.com/owner/repo.git", g.RepoURL)
	}
}
