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

	"github.com/alethialabs-io/alethialabs/packages/core/utils"
	gogit "github.com/go-git/go-git/v5"
)

// tailIsolateAmbientGit removes every ambient identity this host carries but CI does not: the SSH
// agent (so getAuth's token-less arm fails deterministically) and the developer's global git
// config (so go-git's commit author resolution has nothing to fall back on).
func tailIsolateAmbientGit(t *testing.T) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("SSH_AUTH_SOCK", "")
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "xdg"))
}

// tailSkipIfRoot skips a permission-dependent case: root ignores the mode bits these arms need.
func tailSkipIfRoot(t *testing.T) {
	t.Helper()
	if os.Geteuid() == 0 {
		t.Skip("running as root — a 0500 directory is still writable, so this arm cannot be reached")
	}
}

// tailBareClone makes a BARE clone of repo. A bare repository opens fine but has no worktree, which
// is what every "failed to get worktree" arm needs.
func tailBareClone(t *testing.T, repoURL string) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "bare.git")
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git binary not available")
	}
	cmd := exec.Command("git", "clone", "--bare", "-q", repoURL, dir)
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git clone --bare: %v\n%s", err, out)
	}
	return dir
}

// tailOpenBare returns a GIT whose Repo is an opened BARE clone of the fixture repo.
func tailOpenBare(t *testing.T) *GIT {
	t.Helper()
	repo, _, _, _ := makeFixtureRepo(t)
	bare := tailBareClone(t, "file://"+repo)
	opened, err := gogit.PlainOpen(bare)
	if err != nil {
		t.Fatalf("PlainOpen bare: %v", err)
	}
	return &GIT{RepoURL: "file://" + repo, LocalPath: bare, Repo: opened}
}

// TestTail_CloneReuseOfABareCheckoutFailsClosed covers the reuse arm's worktree lookup: an existing
// clone at the path that is BARE has no worktree to check a branch out into, and that must surface
// rather than be mistaken for a healthy reuse.
func TestTail_CloneReuseOfABareCheckoutFailsClosed(t *testing.T) {
	repo, branch, _, _ := makeFixtureRepo(t)
	bare := tailBareClone(t, "file://"+repo)

	g := NewGIT("file://"+repo, bare, false)
	err := g.Clone(context.Background(), branch, false)
	if err == nil || !strings.Contains(err.Error(), "failed to get worktree") {
		t.Fatalf("Clone error = %v, want the worktree failure", err)
	}
}

// TestTail_CloneWarnsWhenNoAuthMethodIsAvailable covers the fresh-clone arm's auth warning: with no
// SSH agent and no token, getAuth fails and the clone continues ANONYMOUSLY rather than aborting —
// which is what makes a public repo work without a connector.
func TestTail_CloneWarnsWhenNoAuthMethodIsAvailable(t *testing.T) {
	tailIsolateAmbientGit(t)
	repo, branch, _, sha2 := makeFixtureRepo(t)

	g := NewGIT("file://"+repo, filepath.Join(t.TempDir(), "clone"), false)
	if err := g.Clone(context.Background(), branch, true); err != nil {
		t.Fatalf("Clone: %v", err)
	}
	head, err := g.HeadSHA()
	if err != nil {
		t.Fatalf("HeadSHA: %v", err)
	}
	if head != sha2 {
		t.Fatalf("HeadSHA = %s, want %s", head, sha2)
	}
}

// TestTail_CloneAndCheckoutCommitReportsUnusableLocalPath covers tryClone's MkdirAll arm (through
// all three ref attempts) and the resulting mapCloneError wrap: a local path nested under a regular
// file can never be created.
func TestTail_CloneAndCheckoutCommitReportsUnusableLocalPath(t *testing.T) {
	tailIsolateAmbientGit(t)
	repo, branch, sha1, _ := makeFixtureRepo(t)

	blocker := filepath.Join(t.TempDir(), "not-a-dir")
	if err := os.WriteFile(blocker, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	g := &GIT{RepoURL: "file://" + repo, LocalPath: filepath.Join(blocker, "clone")}

	err := g.CloneAndCheckoutCommit(branch, sha1, true)
	if err == nil || !strings.Contains(err.Error(), "failed to clone repository") {
		t.Fatalf("CloneAndCheckoutCommit error = %v, want the clone failure", err)
	}
}

// TestTail_CheckoutOfABareCloneFailsClosed covers Checkout's worktree arm: the pinned commit is
// present, but a bare clone has nowhere to materialize it.
func TestTail_CheckoutOfABareCloneFailsClosed(t *testing.T) {
	repo, _, _, sha2 := makeFixtureRepo(t)
	bare := tailBareClone(t, "file://"+repo)
	opened, err := gogit.PlainOpen(bare)
	if err != nil {
		t.Fatalf("PlainOpen bare: %v", err)
	}
	g := &GIT{RepoURL: "file://" + repo, LocalPath: bare, Repo: opened}

	if err := g.Checkout(sha2); err == nil || !strings.Contains(err.Error(), "failed to get worktree") {
		t.Fatalf("Checkout error = %v, want the worktree failure", err)
	}
}

// TestTail_HeadSHAFailureArms covers both of HeadSHA's refusals: an uninitialized wrapper, and a
// repository with no commits at all (HEAD resolves to nothing).
func TestTail_HeadSHAFailureArms(t *testing.T) {
	t.Run("uninitialized", func(t *testing.T) {
		if _, err := (&GIT{}).HeadSHA(); err == nil || !strings.Contains(err.Error(), "not initialized") {
			t.Fatalf("HeadSHA error = %v, want the uninitialized refusal", err)
		}
	})

	t.Run("no commits", func(t *testing.T) {
		dir := t.TempDir()
		repo, err := gogit.PlainInit(dir, false)
		if err != nil {
			t.Fatalf("PlainInit: %v", err)
		}
		g := &GIT{RepoURL: "file://" + dir, LocalPath: dir, Repo: repo}
		if _, err := g.HeadSHA(); err == nil || !strings.Contains(err.Error(), "failed to resolve HEAD") {
			t.Fatalf("HeadSHA error = %v, want the HEAD failure", err)
		}
	})
}

// TestTail_PullFailureArms covers Pull's three remaining arms: a bare clone has no worktree; an
// EMPTY remote is reported and treated as success (nothing to pull is not a failure); any other
// transport failure is wrapped and returned.
func TestTail_PullFailureArms(t *testing.T) {
	t.Run("bare clone", func(t *testing.T) {
		g := tailOpenBare(t)
		if err := g.Pull(context.Background()); err == nil || !strings.Contains(err.Error(), "failed to get worktree") {
			t.Fatalf("Pull error = %v, want the worktree failure", err)
		}
	})

	t.Run("empty remote is not an error", func(t *testing.T) {
		tailIsolateAmbientGit(t)
		repo, branch, _, _ := makeFixtureRepo(t)
		cloneDir := filepath.Join(t.TempDir(), "clone")
		g := NewGIT("file://"+repo, cloneDir, false)
		if err := g.Clone(context.Background(), branch, true); err != nil {
			t.Fatalf("Clone: %v", err)
		}
		// Repoint origin at a brand-new EMPTY bare repository.
		empty := filepath.Join(t.TempDir(), "empty.git")
		gitCmd(t, t.TempDir(), "init", "--bare", "-q", empty)
		gitCmd(t, cloneDir, "remote", "set-url", "origin", "file://"+empty)

		if err := g.Pull(context.Background()); err != nil {
			t.Fatalf("Pull against an empty remote = %v, want nil", err)
		}
	})

	t.Run("missing remote is an error", func(t *testing.T) {
		tailIsolateAmbientGit(t)
		repo, branch, _, _ := makeFixtureRepo(t)
		cloneDir := filepath.Join(t.TempDir(), "clone")
		g := NewGIT("file://"+repo, cloneDir, false)
		if err := g.Clone(context.Background(), branch, true); err != nil {
			t.Fatalf("Clone: %v", err)
		}
		gitCmd(t, cloneDir, "remote", "set-url", "origin", "file://"+filepath.Join(t.TempDir(), "absent"))

		if err := g.Pull(context.Background()); err == nil || !strings.Contains(err.Error(), "failed to pull changes") {
			t.Fatalf("Pull error = %v, want the pull failure", err)
		}
	})
}

// TestTail_PushFailureArms covers Push's two remaining arms: no usable auth method at all, and a
// remote that cannot be reached.
func TestTail_PushFailureArms(t *testing.T) {
	t.Run("no auth method", func(t *testing.T) {
		tailIsolateAmbientGit(t)
		g := tailOpenBare(t)
		if err := g.Push(); err == nil || !strings.Contains(err.Error(), "failed to get auth method") {
			t.Fatalf("Push error = %v, want the auth failure", err)
		}
	})

	t.Run("unreachable remote", func(t *testing.T) {
		tailIsolateAmbientGit(t)
		repo, branch, _, _ := makeFixtureRepo(t)
		cloneDir := filepath.Join(t.TempDir(), "clone")
		g := NewGIT("file://"+repo, cloneDir, false)
		if err := g.Clone(context.Background(), branch, true); err != nil {
			t.Fatalf("Clone: %v", err)
		}
		// A token AFTER the clone: getAuth then succeeds (BasicAuth) so Push reaches the transport,
		// which is the arm under test.
		g.Token = "a-token"
		gitCmd(t, cloneDir, "remote", "set-url", "origin", "file://"+filepath.Join(t.TempDir(), "absent"))

		if err := g.Push(); err == nil || !strings.Contains(err.Error(), "failed to push changes") {
			t.Fatalf("Push error = %v, want the push failure", err)
		}
	})
}

// TestTail_AddAndCommitFailureArms covers AddAndCommit's worktree, add and commit refusals. The
// commit arm is the load-bearing one: with no author identity anywhere, go-git must refuse rather
// than write a commit with an empty author.
func TestTail_AddAndCommitFailureArms(t *testing.T) {
	t.Run("bare clone has no worktree", func(t *testing.T) {
		g := tailOpenBare(t)
		if err := g.AddAndCommit("m"); err == nil || !strings.Contains(err.Error(), "failed to get worktree") {
			t.Fatalf("AddAndCommit error = %v, want the worktree failure", err)
		}
	})

	t.Run("unreadable tree fails the add", func(t *testing.T) {
		tailSkipIfRoot(t)
		tailIsolateAmbientGit(t)
		repo, branch, _, _ := makeFixtureRepo(t)
		cloneDir := filepath.Join(t.TempDir(), "clone")
		g := NewGIT("file://"+repo, cloneDir, false)
		if err := g.Clone(context.Background(), branch, true); err != nil {
			t.Fatalf("Clone: %v", err)
		}
		locked := filepath.Join(cloneDir, "locked")
		if err := os.MkdirAll(locked, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(locked, "f"), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(locked, 0o000); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Chmod(locked, 0o755) })

		if err := g.AddAndCommit("m"); err == nil || !strings.Contains(err.Error(), "failed to add changes") {
			t.Fatalf("AddAndCommit error = %v, want the add failure", err)
		}
	})

	t.Run("no author identity fails the commit", func(t *testing.T) {
		tailIsolateAmbientGit(t)
		repo, branch, _, _ := makeFixtureRepo(t)
		cloneDir := filepath.Join(t.TempDir(), "clone")
		g := NewGIT("file://"+repo, cloneDir, false)
		if err := g.Clone(context.Background(), branch, true); err != nil {
			t.Fatalf("Clone: %v", err)
		}
		if err := os.WriteFile(filepath.Join(cloneDir, "new.txt"), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := g.AddAndCommit("m"); err == nil || !strings.Contains(err.Error(), "failed to commit changes") {
			t.Fatalf("AddAndCommit error = %v, want the commit failure", err)
		}
	})
}

// TestTail_ResetAndRestoreFailureArms covers the worktree, reset and clean refusals.
func TestTail_ResetAndRestoreFailureArms(t *testing.T) {
	t.Run("bare clone has no worktree", func(t *testing.T) {
		g := tailOpenBare(t)
		if err := g.ResetAndRestoreChanges(); err == nil || !strings.Contains(err.Error(), "failed to get worktree") {
			t.Fatalf("ResetAndRestoreChanges error = %v, want the worktree failure", err)
		}
	})

	t.Run("no HEAD fails the reset", func(t *testing.T) {
		dir := t.TempDir()
		repo, err := gogit.PlainInit(dir, false)
		if err != nil {
			t.Fatalf("PlainInit: %v", err)
		}
		g := &GIT{RepoURL: "file://" + dir, LocalPath: dir, Repo: repo}
		if err := g.ResetAndRestoreChanges(); err == nil || !strings.Contains(err.Error(), "failed to reset worktree") {
			t.Fatalf("ResetAndRestoreChanges error = %v, want the reset failure", err)
		}
	})

	t.Run("undeletable untracked dir fails the clean", func(t *testing.T) {
		tailSkipIfRoot(t)
		tailIsolateAmbientGit(t)
		repo, branch, _, _ := makeFixtureRepo(t)
		cloneDir := filepath.Join(t.TempDir(), "clone")
		g := NewGIT("file://"+repo, cloneDir, false)
		if err := g.Clone(context.Background(), branch, true); err != nil {
			t.Fatalf("Clone: %v", err)
		}
		// The hard reset already removes untracked FILES, so the clean arm needs an untracked
		// DIRECTORY tree with no files in it: nothing for the reset to unlink, but a rmdir the
		// clean cannot perform because the parent is not writable.
		locked := filepath.Join(cloneDir, "untracked")
		if err := os.MkdirAll(filepath.Join(locked, "inner"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(locked, 0o500); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Chmod(locked, 0o755) })

		if err := g.ResetAndRestoreChanges(); err == nil || !strings.Contains(err.Error(), "failed to clean worktree") {
			t.Fatalf("ResetAndRestoreChanges error = %v, want the clean failure", err)
		}
	})
}

// TestTail_IsDirtyFailureArms covers the worktree and status refusals. A corrupt index must be
// reported, never read as "clean" — that would let Bootstrap skip a commit it owed.
func TestTail_IsDirtyFailureArms(t *testing.T) {
	t.Run("bare clone has no worktree", func(t *testing.T) {
		g := tailOpenBare(t)
		if _, err := g.IsDirty(); err == nil || !strings.Contains(err.Error(), "failed to get worktree") {
			t.Fatalf("IsDirty error = %v, want the worktree failure", err)
		}
	})

	t.Run("corrupt index fails the status", func(t *testing.T) {
		tailIsolateAmbientGit(t)
		repo, branch, _, _ := makeFixtureRepo(t)
		cloneDir := filepath.Join(t.TempDir(), "clone")
		g := NewGIT("file://"+repo, cloneDir, false)
		if err := g.Clone(context.Background(), branch, true); err != nil {
			t.Fatalf("Clone: %v", err)
		}
		if err := os.WriteFile(filepath.Join(cloneDir, ".git", "index"), []byte("not an index"), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := g.IsDirty(); err == nil || !strings.Contains(err.Error(), "failed to get worktree status") {
			t.Fatalf("IsDirty error = %v, want the status failure", err)
		}
	})
}

// TestTail_CopyFilesFailureArms covers the open and create refusals: a DANGLING symlink is walked
// (Lstat sees a link, not a directory) and cannot be opened; and a destination path already
// occupied by a directory cannot be created as a file.
func TestTail_CopyFilesFailureArms(t *testing.T) {
	t.Run("unopenable source", func(t *testing.T) {
		src := t.TempDir()
		if err := os.Symlink(filepath.Join(src, "nowhere"), filepath.Join(src, "dangling")); err != nil {
			t.Skipf("symlinks unavailable: %v", err)
		}
		g := &GIT{}
		if err := g.CopyFiles(src, t.TempDir(), nil); err == nil {
			t.Fatal("CopyFiles copied a dangling symlink — the open failure must surface")
		}
	})

	t.Run("uncreatable destination", func(t *testing.T) {
		src := t.TempDir()
		if err := os.WriteFile(filepath.Join(src, "x"), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		dst := t.TempDir()
		if err := os.MkdirAll(filepath.Join(dst, "x"), 0o755); err != nil {
			t.Fatal(err)
		}
		g := &GIT{}
		if err := g.CopyFiles(src, dst, nil); err == nil {
			t.Fatal("CopyFiles wrote over a directory — the create failure must surface")
		}
	})
}

// TestTail_ClearRepoContentsFailureArms covers the read-dir and remove refusals.
func TestTail_ClearRepoContentsFailureArms(t *testing.T) {
	tailSkipIfRoot(t)

	t.Run("unreadable directory", func(t *testing.T) {
		dir := filepath.Join(t.TempDir(), "repo")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(dir, 0o000); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Chmod(dir, 0o755) })

		g := &GIT{LocalPath: dir}
		if err := g.ClearRepoContents(); err == nil || !strings.Contains(err.Error(), "failed to read local repository directory") {
			t.Fatalf("ClearRepoContents error = %v, want the read failure", err)
		}
	})

	t.Run("undeletable entry", func(t *testing.T) {
		dir := t.TempDir()
		sub := filepath.Join(dir, "sub")
		if err := os.MkdirAll(sub, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(sub, "f"), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(sub, 0o500); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Chmod(sub, 0o755) })

		g := &GIT{LocalPath: dir}
		if err := g.ClearRepoContents(); err == nil || !strings.Contains(err.Error(), "failed to remove") {
			t.Fatalf("ClearRepoContents error = %v, want the remove failure", err)
		}
	})
}

// TestTail_BootstrapFailureArms covers Bootstrap's error propagation: an unusable local path
// (ClearRepoContents), an absent template repo on the UPDATE arm, an unusable var-file destination
// directory, an unreadable var-file source, a var-file destination that is a directory, and an
// IsDirty failure. Each must abort the bootstrap rather than commit a half-written repo.
func TestTail_BootstrapFailureArms(t *testing.T) {
	logger := utils.NewLogger(nil, "")

	t.Run("unusable local path", func(t *testing.T) {
		g := &GIT{LocalPath: filepath.Join(t.TempDir(), "absent")}
		tmplRepo := &GIT{LocalPath: t.TempDir()}
		if err := g.Bootstrap(tmplRepo, nil, false, logger); err == nil ||
			!strings.Contains(err.Error(), "does not exist or is not a directory") {
			t.Fatalf("Bootstrap error = %v, want the local-path failure", err)
		}
	})

	t.Run("absent template repo on the update arm", func(t *testing.T) {
		local := t.TempDir()
		if err := os.WriteFile(filepath.Join(local, "main.tf"), []byte("# tf"), 0o644); err != nil {
			t.Fatal(err)
		}
		g := &GIT{LocalPath: local}
		tmplRepo := &GIT{LocalPath: filepath.Join(t.TempDir(), "absent")}
		if err := g.Bootstrap(tmplRepo, nil, true, logger); err == nil {
			t.Fatal("Bootstrap accepted a template repo that does not exist")
		}
	})

	t.Run("var file destination under a file", func(t *testing.T) {
		local := t.TempDir()
		if err := os.WriteFile(filepath.Join(local, "main.tf"), []byte("# tf"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(local, "blocker"), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		g := &GIT{LocalPath: local}
		tmplRepo := &GIT{LocalPath: t.TempDir()}
		// updateRepo, so the copy runs even though os.Stat reports the (unstattable) destination
		// as present — otherwise this lands on the "will not overwrite" arm instead.
		if err := g.Bootstrap(tmplRepo, map[string]string{"src.tfvars": "blocker/nested/x.tfvars"}, true, logger); err == nil {
			t.Fatal("Bootstrap accepted a var-file destination nested under a regular file")
		}
	})

	t.Run("absent var file source", func(t *testing.T) {
		local := t.TempDir()
		if err := os.WriteFile(filepath.Join(local, "main.tf"), []byte("# tf"), 0o644); err != nil {
			t.Fatal(err)
		}
		g := &GIT{LocalPath: local}
		tmplRepo := &GIT{LocalPath: t.TempDir()}
		if err := g.Bootstrap(tmplRepo, map[string]string{"absent.tfvars": "vars.tfvars"}, false, logger); err == nil {
			t.Fatal("Bootstrap accepted a var-file source that does not exist")
		}
	})

	t.Run("var file destination is a directory", func(t *testing.T) {
		local := t.TempDir()
		if err := os.WriteFile(filepath.Join(local, "main.tf"), []byte("# tf"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Join(local, "occupied"), 0o755); err != nil {
			t.Fatal(err)
		}
		tmplDir := t.TempDir()
		if err := os.WriteFile(filepath.Join(tmplDir, "src.tfvars"), []byte("a = 1"), 0o644); err != nil {
			t.Fatal(err)
		}
		g := &GIT{LocalPath: local}
		if err := g.Bootstrap(&GIT{LocalPath: tmplDir}, map[string]string{"src.tfvars": "occupied"}, true, logger); err == nil {
			t.Fatal("Bootstrap wrote a var file over a directory")
		}
	})

	t.Run("dirty check needs an initialized repo", func(t *testing.T) {
		local := t.TempDir()
		if err := os.WriteFile(filepath.Join(local, "main.tf"), []byte("# tf"), 0o644); err != nil {
			t.Fatal(err)
		}
		g := &GIT{LocalPath: local}
		if err := g.Bootstrap(&GIT{LocalPath: t.TempDir()}, nil, false, logger); err == nil ||
			!strings.Contains(err.Error(), "not initialized") {
			t.Fatalf("Bootstrap error = %v, want the uninitialized-repo failure", err)
		}
	})
}

// TestTail_BootstrapSurfacesCommitFailure covers the commit arm: real changes are staged, but with
// no author identity anywhere the commit must fail and abort the bootstrap rather than push
// nothing and report success.
func TestTail_BootstrapSurfacesCommitFailure(t *testing.T) {
	tailIsolateAmbientGit(t)
	repo, branch, _, _ := makeFixtureRepo(t)
	cloneDir := filepath.Join(t.TempDir(), "clone")
	g := NewGIT("file://"+repo, cloneDir, false)
	if err := g.Clone(context.Background(), branch, true); err != nil {
		t.Fatalf("Clone: %v", err)
	}

	tmplDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(tmplDir, "main.tf"), []byte("# tf"), 0o644); err != nil {
		t.Fatal(err)
	}
	err := g.Bootstrap(&GIT{LocalPath: tmplDir}, nil, false, utils.NewLogger(nil, ""))
	if err == nil || !strings.Contains(err.Error(), "failed to commit changes") {
		t.Fatalf("Bootstrap error = %v, want the commit failure", err)
	}
}
