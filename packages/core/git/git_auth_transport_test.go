// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package git

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	githttp "github.com/go-git/go-git/v5/plumbing/transport/http"
)

// TestGetAuth_TokenlessHTTPSIsAnonymous is #2035's repro, kept.
//
// getAuth returned an SSH agent method for ANY token-less repo, regardless of transport.
// NewGITWithToken normalizes URLs to https, and go-git's HTTP transport rejects an
// ssh.PublicKeysCallback outright with transport.ErrInvalidAuthMethod before sending a request — so
// the runner's deliberate token-less public clone ("No git token (%v); attempting public clone.")
// died with a misleading "invalid auth method" on every host that has an ssh-agent.
//
// Clone's error branch could not save it: that branch nils the auth out only when getAuth FAILS, and
// with an agent reachable it succeeded.
func TestGetAuth_TokenlessHTTPSIsAnonymous(t *testing.T) {
	// A REACHABLE ssh-agent is the precondition of the bug — with SSH_AUTH_SOCK cleared,
	// getSSHAuthMethod fails and the old code fell back to nil auth by accident, which is why this
	// went unnoticed on CI. Pointing at a live agent is what makes this test meaningful.
	if os.Getenv("SSH_AUTH_SOCK") == "" {
		t.Setenv("SSH_AUTH_SOCK", filepath.Join(t.TempDir(), "agent.sock"))
	}

	for _, url := range []string{
		"https://github.com/acme/public-repo.git",
		"http://internal.example/acme/repo.git",
		"github.com/acme/public-repo", // normalizeRepoURL assumes https for a bare host/path
	} {
		g := &GIT{RepoURL: url}
		auth, err := g.getAuth()
		if err != nil {
			t.Errorf("getAuth(%q) errored for a token-less http remote: %v", url, err)
			continue
		}
		if auth != nil {
			t.Errorf("getAuth(%q) = %T; a token-less http(s) remote must be ANONYMOUS (nil), not an SSH method go-git's HTTP transport will reject", url, auth)
		}
	}
}

// TestGetAuth_TokenStillWins: a token is BasicAuth on http(s), unchanged.
func TestGetAuth_TokenStillWins(t *testing.T) {
	g := &GIT{RepoURL: "https://github.com/acme/private.git", Token: "ghp_x"}
	auth, err := g.getAuth()
	if err != nil {
		t.Fatalf("getAuth: %v", err)
	}
	basic, ok := auth.(*githttp.BasicAuth)
	if !ok {
		t.Fatalf("getAuth = %T, want *http.BasicAuth", auth)
	}
	if basic.Password != "ghp_x" || basic.Username != "x-access-token" {
		t.Errorf("BasicAuth = %s/%s, want x-access-token/ghp_x", basic.Username, basic.Password)
	}
}

// TestGetAuth_SSHRemoteStillUsesTheAgent: the SSH path is not collateral damage. With the agent
// unreachable it must still FAIL rather than silently going anonymous — an ssh remote that needs a
// key and gets none should say so.
func TestGetAuth_SSHRemoteStillUsesTheAgent(t *testing.T) {
	tailIsolateAmbientGit(t) // clears SSH_AUTH_SOCK

	for _, url := range []string{
		"ssh://git@github.com/acme/repo.git",
		"git@github.com:acme/repo.git",
	} {
		g := &GIT{RepoURL: url}
		if _, err := g.getAuth(); err == nil {
			t.Errorf("getAuth(%q) succeeded with no ssh-agent; an ssh remote must not silently go anonymous", url)
		}
	}
}

func TestIsHTTPTransport(t *testing.T) {
	http := []string{
		"https://github.com/a/b.git",
		"http://host/a/b.git",
		"github.com/a/b",           // bare: normalizeRepoURL assumes https
		"  https://github.com/a/b", // leading space
		"file:///tmp/repo",         // needs no credentials; anonymous is right
	}
	for _, s := range http {
		if !isHTTPTransport(s) {
			t.Errorf("isHTTPTransport(%q) = false, want true", s)
		}
	}
	ssh := []string{
		"ssh://git@github.com/a/b.git",
		"git@github.com:a/b.git",
		"git://github.com/a/b.git",
	}
	for _, s := range ssh {
		if isHTTPTransport(s) {
			t.Errorf("isHTTPTransport(%q) = true, want false", s)
		}
	}
}

// TestPublicCloneReachesTheNetwork is the end-to-end half: a token-less clone of an http remote must
// get as far as the SERVER rather than dying in go-git's transport layer. The server 404s, so the
// clone still fails — but on a network answer, which is the distinction that matters.
func TestPublicCloneReachesTheNetwork(t *testing.T) {
	if os.Getenv("SSH_AUTH_SOCK") == "" {
		t.Setenv("SSH_AUTH_SOCK", filepath.Join(t.TempDir(), "agent.sock"))
	}

	g := &GIT{RepoURL: "http://127.0.0.1:1/acme/repo.git", LocalPath: t.TempDir()}
	err := g.Clone(context.Background(), "main", true)
	if err == nil {
		t.Fatal("clone of an unreachable host succeeded?")
	}
	if strings.Contains(err.Error(), "invalid auth method") {
		t.Fatalf("the token-less clone died in the transport layer instead of reaching the network: %v", err)
	}
}
