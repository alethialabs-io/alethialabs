// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package git

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-git/go-git/v5/plumbing/transport"
)

// secretParts are the userinfo fragments planted in the URLs below; none may be printed.
var secretParts = []string{"alice", "s3cr3t-tok", "ghp_planted"}

// assertNoUserinfo fails when text carries any planted userinfo fragment.
func assertNoUserinfo(t *testing.T, where, text string) {
	t.Helper()
	for _, p := range secretParts {
		if strings.Contains(text, p) {
			t.Fatalf("%s carries userinfo fragment %q: %s", where, p, text)
		}
	}
}

// captureStdout runs fn with os.Stdout redirected and returns what it printed.
func captureStdout(t *testing.T, fn func()) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	orig := os.Stdout
	os.Stdout = w
	done := make(chan string)
	go func() {
		b, _ := io.ReadAll(r)
		done <- string(b)
	}()
	defer func() { os.Stdout = orig }()
	fn()
	os.Stdout = orig
	_ = w.Close()
	return <-done
}

// TestRedactURL pins the printed form of each remote shape.
func TestRedactURL(t *testing.T) {
	cases := []struct {
		name, in, want string
	}{
		{"https with user and token", "https://alice:s3cr3t-tok@github.com/o/r.git", "https://github.com/o/r.git"},
		{"https with token as user", "https://ghp_planted@github.com/o/r.git", "https://github.com/o/r.git"},
		{"https with query and fragment", "https://github.com/o/r.git?access_token=s3cr3t-tok#frag", "https://github.com/o/r.git"},
		{"https keeps port", "https://alice:s3cr3t-tok@git.example:8443/o/r", "https://git.example:8443/o/r"},
		{"ssh scheme", "ssh://alice@github.com/o/r.git", "ssh://github.com/o/r.git"},
		{"scp-style drops the user", "alice@github.com:o/r.git", "github.com:o/r.git"},
		{"scp-style git user", "git@github.com:o/r.git", "github.com:o/r.git"},
		{"bare host path with userinfo", "alice:s3cr3t-tok@github.com/o/r.git", "github.com/o/r.git"},
		{"bare host path", "github.com/o/r.git", "github.com/o/r.git"},
		{"file transport", "file:///tmp/repo", "file:///tmp/repo"},
		{"plain https unchanged", "https://github.com/o/r.git", "https://github.com/o/r.git"},
		{"unparseable", "https://alice:s3cr3t-tok@[::1", UnparsedRepoURL},
		{"empty", "  ", UnparsedRepoURL},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := RedactURL(tc.in)
			if got != tc.want {
				t.Fatalf("RedactURL(%q) = %q, want %q", tc.in, got, tc.want)
			}
			assertNoUserinfo(t, "RedactURL", got)
		})
	}
}

// userinfoURLs are the three shapes the clone paths must never print with userinfo.
var userinfoURLs = []string{
	"https://alice:s3cr3t-tok@github.com/o/r.git",
	"alice@github.com:o/r.git",
	"https://alice:s3cr3t-tok@[::1",
}

// TestMapCloneError_NoUserinfo asserts every branch of mapCloneError names the remote without its
// userinfo, keeps the provider's failure reason, and keeps the error chain.
func TestMapCloneError_NoUserinfo(t *testing.T) {
	branches := []struct {
		cause    error
		sentinel error
	}{
		{transport.ErrRepositoryNotFound, ErrRepoNotFound},
		{transport.ErrEmptyRemoteRepository, ErrRepoEmpty},
		{transport.ErrAuthenticationRequired, ErrAuthFailed},
		{transport.ErrAuthorizationFailed, ErrAuthFailed},
	}
	for _, raw := range userinfoURLs {
		for _, b := range branches {
			err := mapCloneError(raw, b.cause)
			if !errors.Is(err, b.sentinel) {
				t.Fatalf("mapCloneError(%q, %v) lost sentinel %v: %v", raw, b.cause, b.sentinel, err)
			}
			if !strings.Contains(err.Error(), b.sentinel.Error()) {
				t.Fatalf("error lost the failure reason %q: %v", b.sentinel, err)
			}
			assertNoUserinfo(t, "mapCloneError", err.Error())
		}
		// Default branch: a transport cause that quotes the endpoint as dialled, userinfo and all.
		cause := fmt.Errorf("Get %q: dial tcp: connection refused", raw)
		err := mapCloneError(raw, cause)
		if !errors.Is(err, cause) {
			t.Fatalf("default branch lost the cause from the chain: %v", err)
		}
		// A remote that does not parse cannot have been dialled, and nothing in a message about it can
		// be shown free of its userinfo, so its cause text is replaced by a fixed reason.
		want := "connection refused"
		if RedactURL(raw) == UnparsedRepoURL {
			want = remoteURLUnparsed
		}
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("default branch lost the failure reason %q: %v", want, err)
		}
		assertNoUserinfo(t, "mapCloneError default", err.Error())
	}
}

// TestScrubCause_EscapedUserinfo covers the userinfo spellings a transport prints: go-git's
// Endpoint.String path-escapes user and password.
func TestScrubCause_EscapedUserinfo(t *testing.T) {
	raw := "https://alice:s3cr3t-tok@github.com/o/r.git"
	for _, msg := range []string{
		"unexpected requesting https://alice:s3cr3t-tok@github.com/o/r.git/info/refs",
		"bad credentials s3cr3t-tok",
		"user alice@ refused",
	} {
		assertNoUserinfo(t, "scrubCause", scrubCause(raw, errors.New(msg)).Error())
	}
	bare := "alice:s3cr3t-tok@github.com/o/r.git"
	assertNoUserinfo(t, "scrubCause bare", scrubCause(bare, errors.New(`Get "https://alice:***@github.com/o/r.git/info/refs"`)).Error())
	plain := errors.New("connection refused")
	if got := scrubCause(raw, plain); got != plain {
		t.Fatalf("scrubCause rewrapped an error with nothing to scrub: %v", got)
	}
}

// TestCloneAndCheckoutCommit_NoUserinfo asserts the pinned-checkout error names the remote without
// its userinfo, for each URL shape. It needs no network: an empty SHA fails before any clone.
func TestCloneAndCheckoutCommit_NoUserinfo(t *testing.T) {
	for _, raw := range userinfoURLs {
		g := &GIT{RepoURL: raw, LocalPath: t.TempDir()}
		err := g.CloneAndCheckoutCommit(context.Background(), "main", "", true)
		if err == nil {
			t.Fatalf("expected an error for an empty commit SHA")
		}
		assertNoUserinfo(t, "CloneAndCheckoutCommit error", err.Error())
	}
}

// TestClone_NoUserinfoInOutputOrError clones from a refused local port with a URL that carries
// userinfo, and asserts neither the `Cloning …` line nor the returned error prints it.
func TestClone_NoUserinfoInOutputOrError(t *testing.T) {
	for _, raw := range []string{
		"https://alice:s3cr3t-tok@127.0.0.1:1/o/r.git",
		"https://ghp_planted@127.0.0.1:1/o/r.git",
	} {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		g := &GIT{RepoURL: raw, LocalPath: t.TempDir()}
		var err error
		out := captureStdout(t, func() { err = g.Clone(ctx, "", true) })
		cancel()
		if err == nil {
			t.Fatalf("expected the clone from a refused port to fail")
		}
		if !strings.Contains(out, "Cloning https://127.0.0.1:1/o/r.git") {
			t.Fatalf("Cloning line missing the redacted URL: %q", out)
		}
		assertNoUserinfo(t, "Clone output", out)
		assertNoUserinfo(t, "Clone error", err.Error())
		g2 := &GIT{RepoURL: raw, LocalPath: t.TempDir()}
		out = captureStdout(t, func() {
			err = g2.CloneAndCheckoutCommit(context.Background(), "", strings.Repeat("a", 40), true)
		})
		if err == nil {
			t.Fatalf("expected the pinned clone from a refused port to fail")
		}
		assertNoUserinfo(t, "CloneAndCheckoutCommit output", out)
		assertNoUserinfo(t, "CloneAndCheckoutCommit error", err.Error())
	}
}

// TestClone_UnparseableRemoteHidesUserinfo covers a remote that does not parse because its userinfo
// holds a character a transport's error message escapes (a quote, a control character). The escaped
// form is not a substring of the raw URL, so the cause text must be replaced, not searched.
func TestClone_UnparseableRemoteHidesUserinfo(t *testing.T) {
	for _, raw := range []string{
		"https://alice:s3cr3t-tok\"x@127.0.0.1:1/o/r.git",
		"https://alice:s3cr3t-tok\x01x@127.0.0.1:1/o/r.git",
	} {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		g := &GIT{RepoURL: raw, LocalPath: t.TempDir()}
		var err error
		out := captureStdout(t, func() { err = g.Clone(ctx, "", true) })
		cancel()
		if err == nil {
			t.Fatalf("expected the clone of an unparseable remote to fail")
		}
		assertNoUserinfo(t, "Clone output", out)
		assertNoUserinfo(t, "Clone error", err.Error())
		if !strings.Contains(err.Error(), remoteURLUnparsed) {
			t.Fatalf("clone error does not say the remote did not parse: %v", err)
		}
	}
}

// TestScrubCause_DropsQueryWithUserinfo asserts the cause text loses the query and fragment along
// with the userinfo, as RedactURL does, when the transport printed the URL with its password masked.
func TestScrubCause_DropsQueryWithUserinfo(t *testing.T) {
	raw := "https://alice:s3cr3t-tok@github.com/o/r?access_token=q-secret#frag"
	got := scrubCause(raw, errors.New(`Get "https://alice:***@github.com/o/r?access_token=q-secret#frag/info/refs": refused`)).Error()
	assertNoUserinfo(t, "scrubCause", got)
	if strings.Contains(got, "q-secret") || strings.Contains(got, "#frag") {
		t.Fatalf("scrubCause kept the query or fragment: %s", got)
	}
}

// TestRedactURL_EdgeShapes pins the scp and bare-host shapes that must fall back or trim.
func TestRedactURL_EdgeShapes(t *testing.T) {
	for raw, want := range map[string]string{
		"git@github.com:o/r.git?ref=main#x": "github.com:o/r.git",
		"git@github.com:o/a@b.git":          UnparsedRepoURL,
		"%zz/o/r":                           UnparsedRepoURL,
	} {
		if got := RedactURL(raw); got != want {
			t.Fatalf("RedactURL(%q) = %q, want %q", raw, got, want)
		}
	}
}

// TestScrubCause_NilAndEmptyUsername covers a nil error and a URL whose userinfo has a password but
// an empty username.
func TestScrubCause_NilAndEmptyUsername(t *testing.T) {
	if scrubCause("https://a:b@h/p", nil) != nil {
		t.Fatalf("scrubCause(nil) must be nil")
	}
	got := scrubCause("https://:s3cr3t-tok@github.com/o/r", errors.New("refused for :s3cr3t-tok@github.com")).Error()
	assertNoUserinfo(t, "scrubCause empty username", got)
}
