// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"bytes"
	"context"
	"errors"
	"net/netip"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/git"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// byoRepoURLResolver answers name lookups for the BYO repository URL tests without touching DNS.
type byoRepoURLResolver map[string]string

// LookupNetIP returns the table's address for host, or an error for a name not in it.
func (r byoRepoURLResolver) LookupNetIP(_ context.Context, _, host string) ([]netip.Addr, error) {
	ip, ok := r[host]
	if !ok {
		return nil, errors.New("no such host")
	}
	return []netip.Addr{netip.MustParseAddr(ip)}, nil
}

// prepareByoForURL runs prepareByoIacWorkdir on a pinned source at raw. With cancelled set the
// context is already cancelled, so a URL that passes the rule stops at the clone instead of reaching
// the network.
func prepareByoForURL(t *testing.T, raw string, cancelled bool) error {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if cancelled {
		cancel()
	}
	vc := &types.ProjectConfig{IacSource: &types.ProjectIacSourceConfig{
		RepoURL: raw, Ref: "main", CommitSHA: strings.Repeat("a", 40), Path: "module",
	}}
	_, _, restore, err := prepareByoIacWorkdir(ctx, vc, "", t.TempDir(), &bytes.Buffer{}, &bytes.Buffer{})
	if restore != nil {
		restore()
	}
	return err
}

// TestPrepareByoIacWorkdir_ValidatesTheRepositoryURL pins the shared repository URL rule on the BYO
// IaC clone: transports other than https/ssh are refused by validateByoRepoURL, and credentials in
// the URL and non-public hosts by git.ValidateRepoURL — over ssh as well as https — while a public
// https URL goes on to the clone.
func TestPrepareByoIacWorkdir_ValidatesTheRepositoryURL(t *testing.T) {
	git.EnforceRepoURLChecksForTest(t, byoRepoURLResolver{
		"github.com":            "140.82.112.3",
		"loopback.example.com":  "127.0.0.1",
		"private.example.com":   "192.168.1.10",
		"linklocal.example.com": "169.254.169.254",
		"cgnat.example.com":     "100.100.0.1",
	})

	transport := map[string]string{
		"file": "file:///etc/repo",
		"git":  "git://github.com/owner/repo.git",
		"http": "http://github.com/owner/repo",
	}
	for name, raw := range transport {
		t.Run(name, func(t *testing.T) {
			if err := prepareByoForURL(t, raw, false); err == nil || !strings.Contains(err.Error(), "https or ssh") {
				t.Fatalf("%q: want the BYO transport refusal, got %v", raw, err)
			}
		})
	}

	hosts := map[string]string{
		"userinfo":         "https://user:secret@github.com/owner/repo",
		"ssh password":     "ssh://git:secret@github.com/owner/repo.git",
		"loopback":         "https://loopback.example.com/owner/repo",
		"private":          "https://private.example.com/owner/repo",
		"private over scp": "git@private.example.com:owner/repo.git",
		"link-local":       "https://linklocal.example.com/owner/repo",
		"metadata literal": "https://169.254.169.254/owner/repo",
		"CGNAT":            "ssh://git@cgnat.example.com/owner/repo.git",
		"localhost":        "https://localhost/owner/repo",
		"internal name":    "git@git.internal:owner/repo.git",
		"local name":       "https://git.local/owner/repo",
	}
	for name, raw := range hosts {
		t.Run(name, func(t *testing.T) {
			if err := prepareByoForURL(t, raw, false); !errors.Is(err, git.ErrRepoURLRefused) {
				t.Fatalf("%q: want a repository URL refusal, got %v", raw, err)
			}
		})
	}

	t.Run("public https", func(t *testing.T) {
		err := prepareByoForURL(t, "https://github.com/owner/repo", true)
		if errors.Is(err, git.ErrRepoURLRefused) || err == nil || !strings.Contains(err.Error(), "clone/checkout failed") {
			t.Fatalf("want the public URL to reach the clone, got %v", err)
		}
	})

	t.Run("operator allowlist", func(t *testing.T) {
		t.Setenv(git.AllowedHostsEnv, "192.168.0.0/16")
		if err := prepareByoForURL(t, "https://private.example.com/owner/repo", true); errors.Is(err, git.ErrRepoURLRefused) {
			t.Fatalf("an allowlisted internal host was refused: %v", err)
		}
	})
}
