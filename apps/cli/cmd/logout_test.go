// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/internal/kubecache"
)

// runLogout runs `alethia logout` in the environment, returning stdout, stderr and whether it took
// the fatal path.
func (e *kcEnv) runLogout() (stdout, stderr string, err error) {
	e.t.Helper()
	_, restore := captureStderr(e.t)
	stdout, err = e.run("logout")
	return stdout, restore(), err
}

// kubeCacheDir is the environment's cache directory.
func kubeCacheDir(t *testing.T) string {
	t.Helper()
	dir, err := kubecache.DefaultDir()
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

// TestLogout_TheNextTokenRemintsAndFailsWithoutALogin is #5323 end to end: a credential cached by
// `cluster token` is gone after logout, so the next call cannot serve it. It has to mint, and with
// no session that fails naming `alethia login`, with no request made.
func TestLogout_TheNextTokenRemintsAndFailsWithoutALogin(t *testing.T) {
	env := newKCEnv(t)
	if _, stderr, err := env.runToken(kcClusterID); err != nil {
		t.Fatalf("seed the cache: %v\n%s", err, stderr)
	}
	if len(env.console.posts) != 1 {
		t.Fatalf("seeding should mint once, got %d", len(env.console.posts))
	}

	stdout, stderr, err := env.runLogout()
	if err != nil {
		t.Fatalf("logout: %v\n%s", err, stderr)
	}
	if !strings.Contains(stdout, "Deleted the cached kubeconfig credentials") {
		t.Errorf("logout does not say it cleared the cache: %q", stdout)
	}
	if _, err := os.Lstat(kubeCacheDir(t)); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("the cache directory survived logout: %v", err)
	}

	stdout, stderr, err = env.runToken(kcClusterID)
	if !errors.Is(err, errMiscExited) {
		t.Fatalf("cluster token after logout served something: err=%v stdout=%q", err, stdout)
	}
	if stdout != "" || strings.Contains(stderr, kcCanary) {
		t.Errorf("the cached credential leaked after logout: stdout=%q stderr=%q", stdout, stderr)
	}
	if !strings.Contains(stderr, "alethia login") {
		t.Errorf("stderr %q does not name alethia login", stderr)
	}
	if len(env.console.posts) != 1 {
		t.Errorf("a mint was requested with no session: %d posts", len(env.console.posts))
	}
}

// TestLogout_ClearsTheCacheWhenNoSessionIsLeft: a credential outlives the session file it was
// minted under, so a logout that finds no session still clears the cache.
func TestLogout_ClearsTheCacheWhenNoSessionIsLeft(t *testing.T) {
	env := newKCEnv(t)
	if _, stderr, err := env.runToken(kcClusterID); err != nil {
		t.Fatalf("seed the cache: %v\n%s", err, stderr)
	}
	credsPath, _ := getCredentialsPath()
	if err := os.Remove(credsPath); err != nil {
		t.Fatal(err)
	}

	stdout, stderr, err := env.runLogout()
	if err != nil {
		t.Fatalf("logout: %v\n%s", err, stderr)
	}
	if !strings.Contains(stdout, "not currently logged in") || !strings.Contains(stdout, "Deleted the cached") {
		t.Errorf("stdout %q", stdout)
	}
	if _, err := os.Lstat(kubeCacheDir(t)); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("the cache directory survived logout: %v", err)
	}
}

// TestLogout_RefusesASymlinkedCacheDir: a cache directory that is a link is not deleted through,
// and logout fails on stderr rather than reporting success over it.
func TestLogout_RefusesASymlinkedCacheDir(t *testing.T) {
	env := newKCEnv(t)
	target := t.TempDir()
	keep := filepath.Join(target, "not-ours.json")
	if err := os.WriteFile(keep, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	dir := kubeCacheDir(t)
	if err := os.MkdirAll(filepath.Dir(dir), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, dir); err != nil {
		t.Fatal(err)
	}

	_, stderr, err := env.runLogout()
	if !errors.Is(err, errMiscExited) {
		t.Fatalf("logout over a symlinked cache should fail, got %v", err)
	}
	if !strings.HasPrefix(stderr, "alethia logout: ") || !strings.Contains(stderr, "symlink") {
		t.Errorf("stderr %q does not explain the refusal", stderr)
	}
	if _, err := os.Stat(keep); err != nil {
		t.Errorf("logout deleted through the link: %v", err)
	}
}

// TestLogout_ReportsACacheItCannotDelete: a cache logout cannot remove leaves a usable credential,
// so logout says so on stderr and exits non-zero instead of claiming success.
func TestLogout_ReportsACacheItCannotDelete(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores the directory's write bit")
	}
	env := newKCEnv(t)
	if _, stderr, err := env.runToken(kcClusterID); err != nil {
		t.Fatalf("seed the cache: %v\n%s", err, stderr)
	}
	dir := kubeCacheDir(t)
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })

	stdout, stderr, err := env.runLogout()
	if !errors.Is(err, errMiscExited) {
		t.Fatalf("logout should fail when the cache survives, got %v (stdout %q)", err, stdout)
	}
	if strings.Contains(stdout, "Successfully logged out") {
		t.Errorf("logout claimed success: %q", stdout)
	}
	for _, want := range []string{"alethia logout: could not delete the cached kubeconfig credentials", dir, "until they expire"} {
		if !strings.Contains(stderr, want) {
			t.Errorf("stderr %q does not say %q", stderr, want)
		}
	}
}
