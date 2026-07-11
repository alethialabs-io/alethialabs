// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package git

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// gitCmd runs a git command in dir and fails the test on error.
func gitCmd(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=test", "GIT_AUTHOR_EMAIL=test@example.com",
		"GIT_COMMITTER_NAME=test", "GIT_COMMITTER_EMAIL=test@example.com",
		"GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null",
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

// makeFixtureRepo builds a repo with two commits on the default branch: commit1
// writes a.txt="v1"; commit2 rewrites it to "v2". Returns (repoDir, branch, sha1, sha2).
func makeFixtureRepo(t *testing.T) (string, string, string, string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git binary not available")
	}
	repo := t.TempDir()
	gitCmd(t, repo, "init", "-q")
	if err := os.WriteFile(filepath.Join(repo, "a.txt"), []byte("v1"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitCmd(t, repo, "add", ".")
	gitCmd(t, repo, "commit", "-q", "-m", "c1")
	sha1 := gitCmd(t, repo, "rev-parse", "HEAD")
	if err := os.WriteFile(filepath.Join(repo, "a.txt"), []byte("v2"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitCmd(t, repo, "add", ".")
	gitCmd(t, repo, "commit", "-q", "-m", "c2")
	sha2 := gitCmd(t, repo, "rev-parse", "HEAD")
	branch := gitCmd(t, repo, "rev-parse", "--abbrev-ref", "HEAD")
	return repo, branch, sha1, sha2
}

// TestCloneAndCheckoutCommitPinsExactCommit asserts the working tree matches the
// PINNED commit, not the branch tip (TOCTOU protection).
func TestCloneAndCheckoutCommitPinsExactCommit(t *testing.T) {
	repo, branch, sha1, sha2 := makeFixtureRepo(t)

	cloneDir := filepath.Join(t.TempDir(), "clone")
	g := &GIT{RepoURL: "file://" + repo, LocalPath: cloneDir}

	// Check out the OLDER commit (sha1) while the branch tip is sha2.
	if err := g.CloneAndCheckoutCommit(branch, sha1, true); err != nil {
		t.Fatalf("CloneAndCheckoutCommit(sha1): %v", err)
	}
	got, err := os.ReadFile(filepath.Join(cloneDir, "a.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "v1" {
		t.Fatalf("pinned checkout landed on the wrong commit: a.txt=%q, want %q (branch tip is %q, not the pin)", got, "v1", sha2)
	}
}

// TestCloneAndCheckoutCommitRejectsMissingSHA asserts a checkout of an absent
// commit fails hard rather than falling back to the ref tip.
func TestCloneAndCheckoutCommitRejectsMissingSHA(t *testing.T) {
	repo, branch, _, _ := makeFixtureRepo(t)
	cloneDir := filepath.Join(t.TempDir(), "clone")
	g := &GIT{RepoURL: "file://" + repo, LocalPath: cloneDir}

	// A well-formed but non-existent SHA must fail (never silently use HEAD).
	bogus := "0123456789abcdef0123456789abcdef01234567"
	if err := g.CloneAndCheckoutCommit(branch, bogus, true); err == nil {
		t.Fatal("expected CloneAndCheckoutCommit to fail on a missing commit, got nil")
	}
}

// TestCheckoutRejectsMalformedSHA asserts the SHA shape is validated.
func TestCheckoutRejectsMalformedSHA(t *testing.T) {
	repo, branch, sha1, _ := makeFixtureRepo(t)
	cloneDir := filepath.Join(t.TempDir(), "clone")
	g := &GIT{RepoURL: "file://" + repo, LocalPath: cloneDir}
	if err := g.CloneAndCheckoutCommit(branch, sha1, true); err != nil {
		t.Fatalf("setup clone: %v", err)
	}
	if err := g.Checkout("deadbeef"); err == nil {
		t.Fatal("expected Checkout to reject a short/malformed SHA")
	}
}
