// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Local git fixtures for the two lanes that PUSH to the customer's apps repo
// (generateAppManifests, writeAddOnGitOps). A bare repo reachable over `file://` is a
// real git transport, so the clone → commit → push round-trip is exercised end to end
// with no network and no token service.

// fixtureGit runs a hermetic git subcommand in dir (no global/system config, fixed identity).
func fixtureGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git binary not available")
	}
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=alethia", "GIT_AUTHOR_EMAIL=alethia@e.com",
		"GIT_COMMITTER_NAME=alethia", "GIT_COMMITTER_EMAIL=alethia@e.com",
		"GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
}

// hermeticGitIdentity points HOME at a throwaway dir holding a .gitconfig with a fixed
// identity.
//
// The env vars fixtureGit sets only reach the `git` BINARY. The code under test commits
// through go-git, which ignores GIT_AUTHOR_* and resolves its identity from the repo config
// and then ~/.gitconfig — so on a machine with no global git config it fails with
// "author field is required". A developer's laptop has that config and CI does not, which is
// the whole reason this is here: without it these tests pass locally and fail in CI.
func hermeticGitIdentity(t *testing.T) {
	t.Helper()
	home := t.TempDir()
	cfg := "[user]\n\tname = alethia\n\temail = alethia@e.com\n"
	if err := os.WriteFile(filepath.Join(home, ".gitconfig"), []byte(cfg), 0o600); err != nil {
		t.Fatalf("write .gitconfig: %v", err)
	}
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
}

// newBareAppsRepo creates a bare git repo seeded with `files` (relative path → content)
// and returns its filesystem path. Pass an empty map for a repo holding only a README.
func newBareAppsRepo(t *testing.T, files map[string]string) string {
	t.Helper()
	hermeticGitIdentity(t)
	bare := t.TempDir()
	fixtureGit(t, bare, "init", "--bare", "-q", "-b", "main")

	work := t.TempDir()
	fixtureGit(t, work, "init", "-q", "-b", "main")
	seed := map[string]string{"README.md": "# apps\n"}
	for k, v := range files {
		seed[k] = v
	}
	for name, body := range seed {
		full := filepath.Join(work, name)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	fixtureGit(t, work, "add", ".")
	fixtureGit(t, work, "commit", "-q", "-m", "seed")
	fixtureGit(t, work, "remote", "add", "origin", bare)
	fixtureGit(t, work, "push", "-q", "origin", "main")
	return bare
}

// readBareRepo clones a bare repo and returns its files as path → content.
func readBareRepo(t *testing.T, bare string) map[string]string {
	t.Helper()
	parent := t.TempDir()
	dst := filepath.Join(parent, "clone")
	fixtureGit(t, parent, "clone", "-q", bare, dst)

	out := map[string]string{}
	err := filepath.Walk(dst, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			if info.Name() == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		rel, relErr := filepath.Rel(dst, path)
		if relErr != nil {
			return relErr
		}
		body, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		out[rel] = string(body)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// commitCount returns how many commits the bare repo's default branch holds.
func commitCount(t *testing.T, bare string) int {
	t.Helper()
	cmd := exec.Command("git", "rev-list", "--count", "HEAD")
	cmd.Dir = bare
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("rev-list: %v", err)
	}
	n := 0
	for _, c := range strings.TrimSpace(string(out)) {
		n = n*10 + int(c-'0')
	}
	return n
}

// writeFileT writes `body` to dir/name (creating parents), failing the test on error.
func writeFileT(t *testing.T, dir, name, body string) {
	t.Helper()
	full := filepath.Join(dir, name)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}
