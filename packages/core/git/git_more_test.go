// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package git

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/utils"
)

// configureCommitIdentity gives a clone a deterministic author so AddAndCommit can
// build a commit without reading the developer's global git config.
func configureCommitIdentity(t *testing.T, dir string) {
	t.Helper()
	gitCmd(t, dir, "config", "user.name", "alethia-test")
	gitCmd(t, dir, "config", "user.email", "test@example.com")
}

// TestTransformURLToHTTPSEdgeCases covers the scheme'd-URL branches that must never be
// re-prefixed, including an ssh:// URL with no host (which is returned untouched).
func TestTransformURLToHTTPSEdgeCases(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{"ssh scheme without host untouched", "ssh://", "ssh://"},
		{"ssh scheme unparseable untouched", "ssh://%zz", "ssh://%zz"},
		{"leading and trailing space trimmed", "  https://github.com/a/b.git  ", "https://github.com/a/b.git"},
		{"scp-like with nested path", "git@gitlab.com:group/sub/repo.git", "https://gitlab.com/group/sub/repo.git"},
		{"unknown scheme untouched", "https+git://host/a.git", "https+git://host/a.git"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := transformURLToHTTPS(tt.in); got != tt.want {
				t.Fatalf("transformURLToHTTPS(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

// TestGetAuthWithoutTokenRequiresSSHAgent pins the token-less branch of getAuth: it
// delegates to the SSH agent, and surfaces a wrapped error when no agent is reachable.
func TestGetAuthWithoutTokenRequiresSSHAgent(t *testing.T) {
	t.Setenv("SSH_AUTH_SOCK", "")
	g := NewGIT("https://github.com/acme/repo.git", t.TempDir(), false)
	auth, err := g.getAuth()
	if err == nil {
		t.Fatalf("getAuth without an SSH agent = %v, want an error", auth)
	}
	if !strings.Contains(err.Error(), "failed to create SSH agent auth") {
		t.Fatalf("getAuth error = %v, want it wrapped as an SSH agent failure", err)
	}
}

// TestCloneReusesAnExistingCorrectClone covers the non-force branch: an existing clone
// of the same remote is opened in place (not re-cloned), the branch is checked out and
// the working tree is reset before pulling.
func TestCloneReusesAnExistingCorrectClone(t *testing.T) {
	repo, branch, _, sha2 := makeFixtureRepo(t)
	cloneDir := filepath.Join(t.TempDir(), "clone")
	g := NewGIT("file://"+repo, cloneDir, false)
	if err := g.Clone(context.Background(), branch, true); err != nil {
		t.Fatalf("initial Clone: %v", err)
	}

	// Leave an untracked file behind; the reuse path must clean it away.
	if err := os.WriteFile(filepath.Join(cloneDir, "untracked.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	reuse := NewGIT("file://"+repo, cloneDir, false)
	if err := reuse.Clone(context.Background(), branch, false); err != nil {
		t.Fatalf("reuse Clone: %v", err)
	}
	if reuse.Repo == nil {
		t.Fatal("reuse Clone did not open the existing repository")
	}
	head, err := reuse.HeadSHA()
	if err != nil {
		t.Fatalf("HeadSHA: %v", err)
	}
	if head != sha2 {
		t.Fatalf("HeadSHA after reuse = %s, want %s", head, sha2)
	}
	if reuse.FileExists("untracked.txt") {
		t.Fatal("reuse Clone did not clean the untracked file")
	}
}

// TestCloneReuseFailsOnUnknownBranch covers the reuse path's checkout-then-fetch retry:
// a branch that exists neither locally nor on the remote must fail loudly.
func TestCloneReuseFailsOnUnknownBranch(t *testing.T) {
	repo, branch, _, _ := makeFixtureRepo(t)
	cloneDir := filepath.Join(t.TempDir(), "clone")
	g := NewGIT("file://"+repo, cloneDir, false)
	if err := g.Clone(context.Background(), branch, true); err != nil {
		t.Fatalf("initial Clone: %v", err)
	}

	reuse := NewGIT("file://"+repo, cloneDir, false)
	err := reuse.Clone(context.Background(), "no-such-branch", false)
	if err == nil {
		t.Fatal("expected Clone to fail for a branch that does not exist")
	}
	if !strings.Contains(err.Error(), "after fetch attempt") {
		t.Fatalf("Clone error = %v, want the post-fetch checkout failure", err)
	}
}

// TestCloneReplacesAWrongRepositoryAtTheSamePath covers the else branch: a local path
// holding a different (or no) repository is wiped and re-cloned.
func TestCloneReplacesAWrongRepositoryAtTheSamePath(t *testing.T) {
	repo, branch, _, _ := makeFixtureRepo(t)
	cloneDir := filepath.Join(t.TempDir(), "clone")
	if err := os.MkdirAll(cloneDir, 0o755); err != nil {
		t.Fatal(err)
	}
	stale := filepath.Join(cloneDir, "stale.txt")
	if err := os.WriteFile(stale, []byte("not a repo"), 0o644); err != nil {
		t.Fatal(err)
	}

	g := NewGIT("file://"+repo, cloneDir, false)
	if g.isCorrectRepo() {
		t.Fatal("isCorrectRepo = true for a directory that is not a repository")
	}
	if err := g.Clone(context.Background(), branch, false); err != nil {
		t.Fatalf("Clone over a non-repository directory: %v", err)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatal("Clone did not remove the stale contents of the local path")
	}
	if !g.FileExists("a.txt") {
		t.Fatal("Clone did not populate the working tree")
	}
}

// TestCloneMissingRemoteMapsToSentinel covers the clone-failure branch and the sentinel
// normalization callers switch on.
func TestCloneMissingRemoteMapsToSentinel(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "nope")
	g := NewGIT("file://"+missing, filepath.Join(t.TempDir(), "clone"), false)
	err := g.Clone(context.Background(), "", true)
	if err == nil {
		t.Fatal("expected Clone of a missing remote to fail")
	}
	if !errors.Is(err, ErrRepoNotFound) && !strings.Contains(err.Error(), "failed to clone repository") {
		t.Fatalf("Clone error = %v, want a mapped clone failure", err)
	}
}

// TestCloneWithoutBranchClonesTheDefaultHead covers the branch=="" branch, which clears
// ReferenceName and drops SingleBranch.
func TestCloneWithoutBranchClonesTheDefaultHead(t *testing.T) {
	repo, _, _, sha2 := makeFixtureRepo(t)
	cloneDir := filepath.Join(t.TempDir(), "clone")
	g := NewGIT("file://"+repo, cloneDir, false)
	if err := g.Clone(context.Background(), "", true); err != nil {
		t.Fatalf("Clone without a branch: %v", err)
	}
	head, err := g.HeadSHA()
	if err != nil {
		t.Fatalf("HeadSHA: %v", err)
	}
	if head != sha2 {
		t.Fatalf("HeadSHA = %s, want the default branch tip %s", head, sha2)
	}
}

// TestPullFetchesNewUpstreamCommits covers the real Pull path, including the
// already-up-to-date result that must not surface as an error.
func TestPullFetchesNewUpstreamCommits(t *testing.T) {
	repo, branch, _, _ := makeFixtureRepo(t)
	cloneDir := filepath.Join(t.TempDir(), "clone")
	g := NewGIT("file://"+repo, cloneDir, false)
	if err := g.Clone(context.Background(), branch, true); err != nil {
		t.Fatalf("Clone: %v", err)
	}

	// A no-op pull must report success, not an error.
	if err := g.Pull(context.Background()); err != nil {
		t.Fatalf("Pull with nothing to fetch: %v", err)
	}

	if err := os.WriteFile(filepath.Join(repo, "b.txt"), []byte("upstream"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitCmd(t, repo, "add", ".")
	gitCmd(t, repo, "commit", "-q", "-m", "c3")
	upstream := gitCmd(t, repo, "rev-parse", "HEAD")

	if err := g.Pull(context.Background()); err != nil {
		t.Fatalf("Pull: %v", err)
	}
	head, err := g.HeadSHA()
	if err != nil {
		t.Fatalf("HeadSHA: %v", err)
	}
	if head != upstream {
		t.Fatalf("HeadSHA after Pull = %s, want %s", head, upstream)
	}
	if !g.FileExists("b.txt") {
		t.Fatal("Pull did not bring the new upstream file into the worktree")
	}
}

// TestAddCommitAndPushLandOnTheRemote covers the real (non dry-run) commit and push
// paths against a local bare remote.
// Uses NewGITWithToken so getAuth takes the token branch. The token-less branch
// unconditionally demands an SSH agent (see the getAuth defect filed by the audit),
// which a CI runner does not have — a developer machine passes only because an agent
// happens to be running. The remote here is a local file:// path, so the credential
// is never actually used.
func TestAddCommitAndPushLandOnTheRemote(t *testing.T) {
	repo, branch, _, _ := makeFixtureRepo(t)
	bare := filepath.Join(t.TempDir(), "bare.git")
	gitCmd(t, t.TempDir(), "clone", "-q", "--bare", repo, bare)

	cloneDir := filepath.Join(t.TempDir(), "clone")
	g := NewGITWithToken("file://"+bare, cloneDir, false, "test-token")
	if err := g.Clone(context.Background(), branch, true); err != nil {
		t.Fatalf("Clone: %v", err)
	}
	configureCommitIdentity(t, cloneDir)

	if err := os.WriteFile(filepath.Join(cloneDir, "new.txt"), []byte("payload"), 0o644); err != nil {
		t.Fatal(err)
	}
	dirty, err := g.IsDirty()
	if err != nil {
		t.Fatalf("IsDirty: %v", err)
	}
	if !dirty {
		t.Fatal("IsDirty = false after adding an untracked file")
	}
	if err := g.AddAndCommit("test: add new.txt"); err != nil {
		t.Fatalf("AddAndCommit: %v", err)
	}
	dirty, err = g.IsDirty()
	if err != nil {
		t.Fatalf("IsDirty after commit: %v", err)
	}
	if dirty {
		t.Fatal("IsDirty = true after committing every change")
	}
	if err := g.Push(context.Background()); err != nil {
		t.Fatalf("Push: %v", err)
	}
	if got := gitCmd(t, bare, "log", "-1", "--pretty=%s", branch); got != "test: add new.txt" {
		t.Fatalf("remote tip subject = %q, want the pushed commit", got)
	}

	// A second push with nothing new must be a no-op, not an error.
	if err := g.Push(context.Background()); err != nil {
		t.Fatalf("Push with nothing to send: %v", err)
	}
}

// TestCloneAndCheckoutCommitRefFallbacks covers the tag branch and the no-ref branch of
// the pinned BYO-IaC clone, plus the empty-SHA guard.
func TestCloneAndCheckoutCommitRefFallbacks(t *testing.T) {
	repo, _, sha1, sha2 := makeFixtureRepo(t)
	gitCmd(t, repo, "tag", "v1.0.0", sha1)

	t.Run("empty sha is refused", func(t *testing.T) {
		g := &GIT{RepoURL: "file://" + repo, LocalPath: filepath.Join(t.TempDir(), "clone")}
		err := g.CloneAndCheckoutCommit(context.Background(), "v1.0.0", "   ", false)
		if err == nil || !strings.Contains(err.Error(), "commit SHA is required") {
			t.Fatalf("CloneAndCheckoutCommit with a blank SHA = %v, want the pin guard", err)
		}
	})

	t.Run("tag ref resolves after the branch attempt fails", func(t *testing.T) {
		cloneDir := filepath.Join(t.TempDir(), "clone")
		g := &GIT{RepoURL: "file://" + repo, LocalPath: cloneDir}
		if err := g.CloneAndCheckoutCommit(context.Background(), "v1.0.0", sha1, true); err != nil {
			t.Fatalf("CloneAndCheckoutCommit(tag): %v", err)
		}
		body, err := os.ReadFile(filepath.Join(cloneDir, "a.txt"))
		if err != nil {
			t.Fatal(err)
		}
		if string(body) != "v1" {
			t.Fatalf("a.txt = %q, want the pinned tag commit content", body)
		}
	})

	t.Run("no ref clones the default branch", func(t *testing.T) {
		cloneDir := filepath.Join(t.TempDir(), "clone")
		g := &GIT{RepoURL: "file://" + repo, LocalPath: cloneDir}
		if err := g.CloneAndCheckoutCommit(context.Background(), "", sha2, true); err != nil {
			t.Fatalf("CloneAndCheckoutCommit(no ref): %v", err)
		}
		head, err := g.HeadSHA()
		if err != nil {
			t.Fatalf("HeadSHA: %v", err)
		}
		if head != sha2 {
			t.Fatalf("HeadSHA = %s, want the pinned %s", head, sha2)
		}
	})

	t.Run("unknown ref and unknown sha fail closed", func(t *testing.T) {
		g := &GIT{RepoURL: "file://" + repo, LocalPath: filepath.Join(t.TempDir(), "clone")}
		err := g.CloneAndCheckoutCommit(context.Background(), "no-such-ref", "0123456789abcdef0123456789abcdef01234567", true)
		if err == nil {
			t.Fatal("expected a fail-closed error for a commit that is not in the clone")
		}
		if !strings.Contains(err.Error(), "no fallback to ref tip") {
			t.Fatalf("error = %v, want the fail-closed pin error", err)
		}
	})
}

// TestCheckoutRejectsShapesAndAbsentCommits covers Checkout's guards.
func TestCheckoutRejectsShapesAndAbsentCommits(t *testing.T) {
	repo, branch, _, _ := makeFixtureRepo(t)
	cloneDir := filepath.Join(t.TempDir(), "clone")
	g := NewGIT("file://"+repo, cloneDir, false)
	if err := g.Clone(context.Background(), branch, true); err != nil {
		t.Fatalf("Clone: %v", err)
	}
	head, err := g.HeadSHA()
	if err != nil {
		t.Fatalf("HeadSHA: %v", err)
	}

	tests := []struct {
		name string
		sha  string
		want string
	}{
		{"too short", "abc123", "must be a full 40-character hex object id"},
		{"41 characters", strings.Repeat("a", 41), "must be a full 40-character hex object id"},
		{"empty", "", "must be a full 40-character hex object id"},
		{"absent commit", "0123456789abcdef0123456789abcdef01234567", "no fallback to ref tip"},
		{"non hex but 40 chars", strings.Repeat("z", 40), "no fallback to ref tip"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := g.Checkout(tt.sha)
			if err == nil {
				t.Fatalf("Checkout(%q) = nil, want an error", tt.sha)
			}
			if !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("Checkout(%q) error = %v, want it to contain %q", tt.sha, err, tt.want)
			}
		})
	}

	// A whitespace-padded but valid SHA is accepted (it is trimmed).
	if err := g.Checkout("  " + head + "  "); err != nil {
		t.Fatalf("Checkout with a padded SHA: %v", err)
	}
}

// TestClearRepoContentsRejectsUnusablePaths covers the guard on a local path that is
// missing or is not a directory.
func TestClearRepoContentsRejectsUnusablePaths(t *testing.T) {
	tmp := t.TempDir()
	file := filepath.Join(tmp, "afile")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name string
		path string
	}{
		{"missing directory", filepath.Join(tmp, "missing")},
		{"path is a regular file", file},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			g := &GIT{LocalPath: tt.path}
			err := g.ClearRepoContents()
			if err == nil {
				t.Fatalf("ClearRepoContents(%q) = nil, want an error", tt.path)
			}
			if !strings.Contains(err.Error(), "does not exist or is not a directory") {
				t.Fatalf("error = %v, want the unusable-path guard", err)
			}
		})
	}
}

// TestCopyFilesPropagatesWalkErrors covers CopyFiles' error branches.
func TestCopyFilesPropagatesWalkErrors(t *testing.T) {
	g := &GIT{LocalPath: t.TempDir()}
	if err := g.CopyFiles(filepath.Join(t.TempDir(), "missing"), t.TempDir(), nil); err == nil {
		t.Fatal("CopyFiles from a missing source = nil, want an error")
	}

	// A destination that cannot be created (its parent is a regular file) must surface.
	src := t.TempDir()
	if err := os.WriteFile(filepath.Join(src, "f.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	blocker := filepath.Join(t.TempDir(), "blocker")
	if err := os.WriteFile(blocker, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := g.CopyFiles(src, filepath.Join(blocker, "dst"), nil); err == nil {
		t.Fatal("CopyFiles into an uncreatable destination = nil, want an error")
	}
}

// TestCopyFilesIgnoresListedEntries covers the ignore matching for both a directory and
// an exact file, and the nested-directory recreation.
func TestCopyFilesIgnoresListedEntries(t *testing.T) {
	tmp := t.TempDir()
	src := filepath.Join(tmp, "src")
	dst := filepath.Join(tmp, "dst")
	for _, d := range []string{filepath.Join(src, "keep"), filepath.Join(src, "skipdir"), dst} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for path, body := range map[string]string{
		filepath.Join(src, "keep", "a.tf"):    "a",
		filepath.Join(src, "skipdir", "b.tf"): "b",
		filepath.Join(src, "skipfile.tf"):     "c",
		filepath.Join(src, "main.tf"):         "d",
	} {
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	g := &GIT{LocalPath: dst}
	if err := g.CopyFiles(src, dst, []string{"skipdir", "skipfile.tf"}); err != nil {
		t.Fatalf("CopyFiles: %v", err)
	}
	for _, want := range []string{"keep/a.tf", "main.tf"} {
		if !g.FileExists(want) {
			t.Fatalf("CopyFiles did not copy %s", want)
		}
	}
	for _, unwanted := range []string{"skipdir/b.tf", "skipfile.tf"} {
		if _, err := os.Stat(filepath.Join(dst, unwanted)); !os.IsNotExist(err) {
			t.Fatalf("CopyFiles copied the ignored entry %s", unwanted)
		}
	}
}

// TestBootstrapUpdateAndNoOpPaths covers Bootstrap's update-flag branch, its
// leave-alone branch, and the "no changes" early return.
// Uses NewGITWithToken so getAuth takes the token branch. The token-less branch
// unconditionally demands an SSH agent (see the getAuth defect filed by the audit),
// which a CI runner does not have — a developer machine passes only because an agent
// happens to be running. The remote here is a local file:// path, so the credential
// is never actually used.
func TestBootstrapUpdateAndNoOpPaths(t *testing.T) {
	repo, branch, _, _ := makeFixtureRepo(t)
	bare := filepath.Join(t.TempDir(), "bare.git")
	gitCmd(t, t.TempDir(), "clone", "-q", "--bare", repo, bare)

	tmpl := t.TempDir()
	if err := os.MkdirAll(filepath.Join(tmpl, "vars"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tmpl, "main.tf"), []byte("v1"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tmpl, "vars", "prod.tfvars"), []byte("region=eu"), 0o644); err != nil {
		t.Fatal(err)
	}
	template := &GIT{LocalPath: tmpl}
	filesMap := map[string]string{"vars/prod.tfvars": "env/prod.tfvars"}
	logger := utils.NewLogger(nil, "")

	cloneDir := filepath.Join(t.TempDir(), "clone")
	client := NewGITWithToken("file://"+bare, cloneDir, false, "test-token")
	if err := client.Clone(context.Background(), branch, true); err != nil {
		t.Fatalf("Clone: %v", err)
	}
	configureCommitIdentity(t, cloneDir)

	// First run: no main.tf yet -> clear + copy + commit + push.
	if err := client.Bootstrap(context.Background(), template, filesMap, false, logger); err != nil {
		t.Fatalf("Bootstrap (initial): %v", err)
	}
	for _, want := range []string{"main.tf", "env/prod.tfvars"} {
		if !client.FileExists(want) {
			t.Fatalf("Bootstrap did not create %s", want)
		}
	}

	// Second run with updateRepo=false: main.tf is left alone and nothing is committed.
	if err := os.WriteFile(filepath.Join(tmpl, "main.tf"), []byte("v2"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := client.Bootstrap(context.Background(), template, filesMap, false, logger); err != nil {
		t.Fatalf("Bootstrap (no-op): %v", err)
	}
	body, err := os.ReadFile(filepath.Join(cloneDir, "main.tf"))
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "v1" {
		t.Fatalf("main.tf = %q, want the existing file to be preserved without the update flag", body)
	}

	// Third run with updateRepo=true: the template overwrites what is there.
	if err := client.Bootstrap(context.Background(), template, filesMap, true, logger); err != nil {
		t.Fatalf("Bootstrap (update): %v", err)
	}
	body, err = os.ReadFile(filepath.Join(cloneDir, "main.tf"))
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "v2" {
		t.Fatalf("main.tf = %q, want the template content after an update run", body)
	}
}

// TestBootstrapSurfacesTemplateErrors covers Bootstrap's error propagation when the
// template repository cannot be read.
func TestBootstrapSurfacesTemplateErrors(t *testing.T) {
	repo, branch, _, _ := makeFixtureRepo(t)
	cloneDir := filepath.Join(t.TempDir(), "clone")
	client := NewGIT("file://"+repo, cloneDir, true)
	if err := client.Clone(context.Background(), branch, true); err != nil {
		t.Fatalf("Clone: %v", err)
	}
	template := &GIT{LocalPath: filepath.Join(t.TempDir(), "missing-template")}
	if err := client.Bootstrap(context.Background(), template, nil, false, utils.NewLogger(nil, "")); err == nil {
		t.Fatal("Bootstrap with a missing template = nil, want an error")
	}
}

// TestIsCorrectRepoRejectsForeignRemotes covers the remote-URL comparison.
func TestIsCorrectRepoRejectsForeignRemotes(t *testing.T) {
	repo, branch, _, _ := makeFixtureRepo(t)
	cloneDir := filepath.Join(t.TempDir(), "clone")
	g := NewGIT("file://"+repo, cloneDir, false)
	if err := g.Clone(context.Background(), branch, true); err != nil {
		t.Fatalf("Clone: %v", err)
	}
	if !g.isCorrectRepo() {
		t.Fatal("isCorrectRepo = false for the repository it just cloned")
	}
	other := NewGIT("file:///somewhere/else.git", cloneDir, false)
	if other.isCorrectRepo() {
		t.Fatal("isCorrectRepo = true for a different remote URL")
	}
	missing := NewGIT("file://"+repo, filepath.Join(t.TempDir(), "nothing"), false)
	if missing.isCorrectRepo() {
		t.Fatal("isCorrectRepo = true for a path that holds no repository")
	}
}
