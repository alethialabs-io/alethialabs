// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestIsRepoAnonymouslyCloneable_PublicVsPrivate proves the token gate is only relaxed for a repo
// whose anonymous ref advertisement returns 200 (public), and stays required (false) for 401/403
// (private) — the fail-closed guarantee deploy.go relies on.
func TestIsRepoAnonymouslyCloneable_PublicVsPrivate(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		want   bool
	}{
		{"public repo (200)", http.StatusOK, true},
		{"private repo (401)", http.StatusUnauthorized, false},
		{"forbidden repo (403)", http.StatusForbidden, false},
		{"missing repo (404)", http.StatusNotFound, false},
		{"server error (500)", http.StatusInternalServerError, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var gotPath string
			srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotPath = r.URL.RequestURI()
				// The probe must NOT send credentials — it mirrors git's first anonymous fetch.
				if r.Header.Get("Authorization") != "" {
					t.Errorf("probe sent Authorization header; must be anonymous")
				}
				w.WriteHeader(tc.status)
			}))
			defer srv.Close()

			prev := probeHTTPClient
			probeHTTPClient = srv.Client() // trusts the test server's TLS cert
			defer func() { probeHTTPClient = prev }()

			got := IsRepoAnonymouslyCloneable(context.Background(), srv.URL+"/org/repo")
			if got != tc.want {
				t.Fatalf("IsRepoAnonymouslyCloneable = %v, want %v", got, tc.want)
			}
			// It must hit the git smart-HTTP ref-advertisement endpoint.
			if want := "/org/repo/info/refs?service=git-upload-pack"; gotPath != want {
				t.Fatalf("probed path = %q, want %q", gotPath, want)
			}
		})
	}
}

// TestIsRepoAnonymouslyCloneable_NonHTTPS proves non-https URLs are never probed and always require a
// token (ssh/git/http are unprobeable or would widen the SSRF surface beyond the clone ArgoCD does).
func TestIsRepoAnonymouslyCloneable_NonHTTPS(t *testing.T) {
	// If any of these actually issued a request, the nil transport would panic — so a false here
	// also proves no network call was attempted.
	probeHTTPClient = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		t.Fatalf("non-https URL must not be probed")
		return nil, nil
	})}
	defer func() { probeHTTPClient = http.DefaultClient }()

	for _, url := range []string{
		"git@github.com:org/repo.git",
		"ssh://git@github.com/org/repo.git",
		"http://github.com/org/repo",
		"",
		"   ",
		"file:///etc/passwd",
	} {
		if IsRepoAnonymouslyCloneable(context.Background(), url) {
			t.Errorf("url %q reported anonymously cloneable; want false (require token)", url)
		}
	}
}

// TestIsRepoAnonymouslyCloneable_TrimsSuffixes proves a trailing slash and a `.git` suffix are
// normalized so the probe URL is well-formed.
func TestIsRepoAnonymouslyCloneable_TrimsSuffixes(t *testing.T) {
	var gotPath string
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.RequestURI()
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	prev := probeHTTPClient
	probeHTTPClient = srv.Client()
	defer func() { probeHTTPClient = prev }()

	if !IsRepoAnonymouslyCloneable(context.Background(), srv.URL+"/org/repo.git/") {
		t.Fatal("expected .git/ suffixed public repo to be cloneable")
	}
	if strings.Contains(gotPath, ".git") || strings.Contains(gotPath, "//info") {
		t.Fatalf("suffix not normalized: probed %q", gotPath)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
