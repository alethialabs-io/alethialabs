// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package git

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	gogit "github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/config"
	"github.com/go-git/go-git/v5/plumbing/object"
)

// stalledGitServer accepts the connection and then never answers, which is the shape that matters:
// a hung proxy, a black-holed firewall or a wedged git server. go-git's HTTP transport has no
// default client timeout, so without a context the call blocks forever rather than failing.
func stalledGitServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done() // hold the request open until the client gives up
	}))
	t.Cleanup(srv.Close)
	return srv
}

// assertBoundedByContext runs op with an already-short deadline and fails if it does not return
// promptly. The generous ceiling is deliberate: this asserts "terminates", not "terminates in
// exactly N ms", so it cannot go flaky on a loaded CI box.
func assertBoundedByContext(t *testing.T, name string, op func(context.Context) error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()

	done := make(chan error, 1)
	start := time.Now()
	go func() { done <- op(ctx) }()

	select {
	case err := <-done:
		if err == nil {
			t.Fatalf("%s returned nil against a stalled remote; want a cancellation error", name)
		}
		// The error may be wrapped by go-git or by our own message; either way the deadline is the
		// cause, and what matters is that it RETURNED.
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Logf("%s returned %v (not wrapping DeadlineExceeded) — acceptable, the contract is that it terminates", name, err)
		}
		if elapsed := time.Since(start); elapsed > 20*time.Second {
			t.Errorf("%s took %s to notice the deadline", name, elapsed)
		}
	case <-time.After(20 * time.Second):
		t.Fatalf("HUNG: %s did not return within 20s against a stalled remote — the job could not be cancelled and would hold its runner slot until the process was killed", name)
	}
}

// TestCloneAndCheckoutCommit_IsBoundedByContext is #2034's repro for the BYO-IaC entry point.
//
// Clone and Pull were given a ctx by #987; CloneAndCheckoutCommit (the BYO-IaC path,
// provisioner/byo_iac.go) and Push (the GitOps write path) were not, and used the non-Context go-git
// calls. Both callers held a live ctx the whole time.
func TestCloneAndCheckoutCommit_IsBoundedByContext(t *testing.T) {
	srv := stalledGitServer(t)
	// A Token is REQUIRED for this test to mean anything: without one getAuth() fails with
	// "invalid auth method" in single-digit milliseconds and the call never reaches the network,
	// so the test would pass against the unfixed code. It caught exactly that during review.
	g := &GIT{RepoURL: srv.URL + "/org/repo.git", LocalPath: t.TempDir(), Token: "test-token"}

	assertBoundedByContext(t, "CloneAndCheckoutCommit", func(ctx context.Context) error {
		return g.CloneAndCheckoutCommit(ctx, "main", "0123456789abcdef0123456789abcdef01234567", true)
	})
}

// TestPush_IsBoundedByContext is the write-path half. Push needs a real repository with a remote
// before it reaches the network, so this builds one locally and points its origin at the stall.
func TestPush_IsBoundedByContext(t *testing.T) {
	srv := stalledGitServer(t)

	// A local repo with one commit and an origin pointing at the stalled server.
	dir := t.TempDir()
	g := &GIT{RepoURL: srv.URL + "/org/repo.git", LocalPath: dir, Token: "test-token"}
	repo, err := initRepoWithRemote(t, dir, srv.URL+"/org/repo.git")
	if err != nil {
		t.Skipf("could not build a local repo for the push test: %v", err)
	}
	g.Repo = repo

	assertBoundedByContext(t, "Push", func(ctx context.Context) error {
		return g.Push(ctx)
	})
}

// initRepoWithRemote builds a real one-commit repository whose `origin` points at remoteURL, so
// Push reaches the network rather than failing earlier on a missing repo or remote.
func initRepoWithRemote(t *testing.T, dir, remoteURL string) (*gogit.Repository, error) {
	t.Helper()
	repo, err := gogit.PlainInit(dir, false)
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(filepath.Join(dir, "f.txt"), []byte("x"), 0o600); err != nil {
		return nil, err
	}
	wt, err := repo.Worktree()
	if err != nil {
		return nil, err
	}
	if _, err := wt.Add("f.txt"); err != nil {
		return nil, err
	}
	if _, err := wt.Commit("seed", &gogit.CommitOptions{
		Author: &object.Signature{Name: "t", Email: "t@example.com", When: time.Now()},
	}); err != nil {
		return nil, err
	}
	if _, err := repo.CreateRemote(&config.RemoteConfig{Name: "origin", URLs: []string{remoteURL}}); err != nil {
		return nil, err
	}
	return repo, nil
}

// TestStalledServerIsActuallyStalled guards the fixture. If the stub answered quickly, both tests
// above would pass against the UNFIXED code and prove nothing.
func TestStalledServerIsActuallyStalled(t *testing.T) {
	srv := stalledGitServer(t)

	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/info/refs", nil)
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	resp, err := http.DefaultClient.Do(req) //nolint:bodyclose // the request never completes
	if err == nil {
		resp.Body.Close()
		t.Fatalf("the stub answered in %s — it is not stalling, so the tests above would prove nothing", time.Since(start))
	}
	var nerr net.Error
	if !errors.As(err, &nerr) && !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("stub failed for an unexpected reason (not a timeout): %v", err)
	}
}
