// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package git

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// refFixture is a BARE repository whose refs each point at different bytes, so a clone that
// resolves a ref to the wrong thing reads the wrong a.txt.
type refFixture struct {
	url        string // file:// URL of the bare repo
	trunkSHA   string // tip of the default branch "trunk" (a.txt = "trunk")
	featureSHA string // tip of branch "feature" (a.txt = "feature")
	oldSHA     string // first commit on trunk (a.txt = "old"), also tagged v1 (annotated)
}

// makeBareRefFixture builds the bare fixture. The default branch is deliberately NOT main/master,
// so a clone that guesses a name instead of asking the remote for HEAD is caught.
func makeBareRefFixture(t *testing.T) refFixture {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git binary not available")
	}
	work := t.TempDir()
	write := func(content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(work, "a.txt"), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		gitCmd(t, work, "add", ".")
		gitCmd(t, work, "commit", "-q", "-m", content)
	}
	gitCmd(t, work, "init", "-q", "-b", "trunk")
	write("old")
	oldSHA := gitCmd(t, work, "rev-parse", "HEAD")
	gitCmd(t, work, "tag", "-a", "v1", "-m", "v1")
	write("trunk")
	trunkSHA := gitCmd(t, work, "rev-parse", "HEAD")
	gitCmd(t, work, "checkout", "-q", "-b", "feature", oldSHA)
	write("feature")
	featureSHA := gitCmd(t, work, "rev-parse", "HEAD")
	gitCmd(t, work, "checkout", "-q", "trunk")

	bare := filepath.Join(t.TempDir(), "remote.git")
	gitCmd(t, work, "clone", "-q", "--bare", work, bare)
	return refFixture{url: "file://" + bare, trunkSHA: trunkSHA, featureSHA: featureSHA, oldSHA: oldSHA}
}

// TestCloneResolvesEveryDocumentedRefKind locks the contract `--ref` documents — "the branch, tag
// or commit; empty tracks the repository's default branch" — at the shared clone every scan uses.
// Before the fix, Clone passed every ref to NewBranchReferenceName, so HEAD asked the remote for
// refs/heads/HEAD (cli-demo grid 36652642517) and a tag or SHA could never be cloned at all.
func TestCloneResolvesEveryDocumentedRefKind(t *testing.T) {
	fx := makeBareRefFixture(t)
	cases := []struct {
		name     string
		ref      string
		wantFile string
		wantSHA  string
	}{
		{"HEAD is the default branch", "HEAD", "trunk", fx.trunkSHA},
		{"empty is the default branch", "", "trunk", fx.trunkSHA},
		{"branch", "feature", "feature", fx.featureSHA},
		{"fully-qualified branch", "refs/heads/feature", "feature", fx.featureSHA},
		{"annotated tag", "v1", "old", fx.oldSHA},
		{"full commit SHA off the branch tip", fx.oldSHA, "old", fx.oldSHA},
		{"full commit SHA on a non-default branch", fx.featureSHA, "feature", fx.featureSHA},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := filepath.Join(t.TempDir(), "clone")
			g := &GIT{RepoURL: fx.url, LocalPath: dir}
			if err := g.Clone(context.Background(), tc.ref, true); err != nil {
				t.Fatalf("Clone(ref=%q): %v", tc.ref, err)
			}
			got, err := os.ReadFile(filepath.Join(dir, "a.txt"))
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != tc.wantFile {
				t.Fatalf("Clone(ref=%q) checked out a.txt=%q, want %q", tc.ref, got, tc.wantFile)
			}
			// The IaC scan PINS HeadSHA as the commit a later deploy applies, so it must name the
			// commit the ref resolved to — for an annotated tag, the commit, never the tag object.
			sha, err := g.HeadSHA()
			if err != nil {
				t.Fatalf("HeadSHA after Clone(ref=%q): %v", tc.ref, err)
			}
			if sha != tc.wantSHA {
				t.Fatalf("HeadSHA after Clone(ref=%q) = %s, want %s", tc.ref, sha, tc.wantSHA)
			}
		})
	}
}

// TestCloneRefusesAnUnknownRefInsteadOfFallingBack asserts a name that is neither a branch nor a
// tag fails, rather than silently scanning the default branch's bytes under the user's ref.
func TestCloneRefusesAnUnknownRefInsteadOfFallingBack(t *testing.T) {
	fx := makeBareRefFixture(t)
	g := &GIT{RepoURL: fx.url, LocalPath: filepath.Join(t.TempDir(), "clone")}
	err := g.Clone(context.Background(), "no-such-ref", true)
	if err == nil {
		t.Fatal("Clone of an unknown ref succeeded; it must fail rather than fall back to the default branch")
	}
	if !strings.Contains(err.Error(), "neither a branch nor a tag") {
		t.Fatalf("unknown-ref error does not say what was tried: %v", err)
	}
}

// TestCloneRefusesAnAbsentCommitSHA asserts a well-formed SHA the remote does not have fails
// closed instead of leaving the default branch checked out.
func TestCloneRefusesAnAbsentCommitSHA(t *testing.T) {
	fx := makeBareRefFixture(t)
	g := &GIT{RepoURL: fx.url, LocalPath: filepath.Join(t.TempDir(), "clone")}
	if err := g.Clone(context.Background(), "0123456789abcdef0123456789abcdef01234567", true); err == nil {
		t.Fatal("Clone of an absent commit SHA succeeded; it must fail closed")
	}
}

// TestIsFullCommitSHA pins the SHA shape test that routes a ref to the full-clone path.
func TestIsFullCommitSHA(t *testing.T) {
	for ref, want := range map[string]bool{
		"0123456789abcdef0123456789abcdef01234567": true,
		"0123456789ABCDEF0123456789ABCDEF01234567": true,
		"0123456789abcdef":                         false,
		"0123456789abcdef0123456789abcdef0123456g": false,
		"main": false,
		"":     false,
	} {
		if got := isFullCommitSHA(ref); got != want {
			t.Errorf("isFullCommitSHA(%q) = %v, want %v", ref, got, want)
		}
	}
}
