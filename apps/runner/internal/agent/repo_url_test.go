// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"errors"
	"net/netip"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/git"
)

// repoURLResolver answers name lookups for the repository URL tests without touching DNS.
type repoURLResolver map[string]string

// LookupNetIP returns the table's address for host, or an error for a name not in it.
func (r repoURLResolver) LookupNetIP(_ context.Context, _, host string) ([]netip.Addr, error) {
	ip, ok := r[host]
	if !ok {
		return nil, errors.New("no such host")
	}
	return []netip.Addr{netip.MustParseAddr(ip)}, nil
}

// repoURLDNS maps the test names to the address classes the rule refuses, and one public name.
var repoURLDNS = repoURLResolver{
	"github.com":            "140.82.112.3",
	"loopback.example.com":  "127.0.0.1",
	"private.example.com":   "10.1.2.3",
	"linklocal.example.com": "169.254.169.254",
	"cgnat.example.com":     "100.64.0.7",
	"ula.example.com":       "fd00::1",
}

// refusedRepoURLs is one URL per refused class, shared by the ANALYZE_REPO and IAC_SCAN tests.
var refusedRepoURLs = map[string]string{
	"file":             "file:///etc/repo",
	"git":              "git://github.com/owner/repo.git",
	"http":             "http://github.com/owner/repo",
	"userinfo":         "https://user:secret@github.com/owner/repo",
	"loopback":         "https://loopback.example.com/owner/repo",
	"loopback literal": "https://127.0.0.1/owner/repo",
	"private":          "https://private.example.com/owner/repo",
	"link-local":       "https://linklocal.example.com/owner/repo",
	"metadata literal": "https://169.254.169.254/owner/repo",
	"CGNAT":            "https://cgnat.example.com/owner/repo",
	"ULA":              "https://ula.example.com/owner/repo",
	"localhost":        "https://localhost/owner/repo",
	"internal name":    "https://git.internal/owner/repo",
	"local name":       "https://git.local/owner/repo",
}

// TestAnalyzeRepo_ValidatesTheRepositoryURL pins that ANALYZE_REPO refuses every refused class
// before it requests a token or clones, refuses ssh (an analysis clones over https), and lets a
// public https URL through to the clone.
func TestAnalyzeRepo_ValidatesTheRepositoryURL(t *testing.T) {
	git.EnforceRepoURLChecksForTest(t, repoURLDNS)

	cases := map[string]string{"ssh where not allowed": "ssh://git@github.com/owner/repo.git"}
	for k, v := range refusedRepoURLs {
		cases[k] = v
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			api := covDriftNewAPI()
			w := covDriftRunner(t, api, "self", nil)
			out, errl := covDriftLoggers(t, api)
			job := &Job{ID: "analyze", JobType: "ANALYZE_REPO", ConfigSnapshot: map[string]any{"repo_url": raw}}
			err := w.executeAnalyzeRepo(context.Background(), job, out, errl)
			if !errors.Is(err, git.ErrRepoURLRefused) {
				t.Fatalf("%q: want a repository URL refusal, got %v", raw, err)
			}
			if api.gitTokenCalls != 0 {
				t.Fatalf("%q: a token was requested for a refused URL", raw)
			}
		})
	}

	t.Run("public https", func(t *testing.T) {
		api := covDriftNewAPI()
		w := covDriftRunner(t, api, "self", nil)
		out, errl := covDriftLoggers(t, api)
		// A cancelled context stops the clone before it reaches the network; what matters is that
		// the URL passed the rule and the job went on to request a token and clone.
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		job := &Job{ID: "analyze", JobType: "ANALYZE_REPO", ConfigSnapshot: map[string]any{"repo_url": "https://github.com/owner/repo"}}
		err := w.executeAnalyzeRepo(ctx, job, out, errl)
		if errors.Is(err, git.ErrRepoURLRefused) {
			t.Fatalf("a public https URL was refused: %v", err)
		}
		if api.gitTokenCalls != 1 {
			t.Fatalf("want the token request that follows an accepted URL, got %d", api.gitTokenCalls)
		}
	})
}

// TestIacScan_ValidatesTheRepositoryURL pins the same rule on IAC_SCAN, where ssh is accepted (a
// BYO IaC repository may be read with a deploy key) and the host rules still apply to it.
func TestIacScan_ValidatesTheRepositoryURL(t *testing.T) {
	git.EnforceRepoURLChecksForTest(t, repoURLDNS)

	cases := map[string]string{"ssh to a private host": "git@private.example.com:owner/repo.git"}
	for k, v := range refusedRepoURLs {
		cases[k] = v
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			api := &mockAPI{}
			w := runnerForScan(t, api)
			job := &Job{ID: "scan", JobType: "IAC_SCAN", ConfigSnapshot: map[string]any{"repo_url": raw, "path": "."}}
			stdout := NewJobLogger(api, job.ID, "STDOUT")
			stderr := NewJobLogger(api, job.ID, "STDERR")
			defer stdout.Close()
			defer stderr.Close()
			if err := w.executeIacScan(context.Background(), job, stdout, stderr); !errors.Is(err, git.ErrRepoURLRefused) {
				t.Fatalf("%q: want a repository URL refusal, got %v", raw, err)
			}
		})
	}

	// ssh acceptance is pinned in packages/core/git; an ssh clone here would dial by name.
	for _, raw := range []string{"https://github.com/owner/repo"} {
		t.Run("accepted "+raw, func(t *testing.T) {
			api := &mockAPI{}
			w := runnerForScan(t, api)
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			job := &Job{ID: "scan", JobType: "IAC_SCAN", ConfigSnapshot: map[string]any{"repo_url": raw, "path": "."}}
			stdout := NewJobLogger(api, job.ID, "STDOUT")
			stderr := NewJobLogger(api, job.ID, "STDERR")
			defer stdout.Close()
			defer stderr.Close()
			if err := w.executeIacScan(ctx, job, stdout, stderr); errors.Is(err, git.ErrRepoURLRefused) {
				t.Fatalf("%q was refused: %v", raw, err)
			}
		})
	}
}
