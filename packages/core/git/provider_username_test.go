// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package git

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	githttp "github.com/go-git/go-git/v5/plumbing/transport/http"
)

// providerUsernames is the table #6599 asks for: the username each provider requires with an OAuth
// access token. Bitbucket Cloud refuses `x-access-token` even for a read, so a private Bitbucket
// repo could not be cloned at all while every provider got that username.
var providerUsernames = []struct {
	provider string
	want     string
}{
	{ProviderGitHub, "x-access-token"},
	{ProviderGitLab, "oauth2"},
	{ProviderBitbucket, "x-token-auth"},
	// A console that predates the `provider` field names none: the username sent before it existed.
	{"", "x-access-token"},
	{"gitea", "x-access-token"},
}

// TestTokenUsername_PerProvider pins the username table itself.
func TestTokenUsername_PerProvider(t *testing.T) {
	for _, tc := range providerUsernames {
		if got := TokenUsername(tc.provider); got != tc.want {
			t.Errorf("TokenUsername(%q) = %q, want %q", tc.provider, got, tc.want)
		}
	}
}

// TestGetAuth_UsernamePerProvider checks the provider given to NewGITWithToken reaches the auth
// method every clone, fetch and push uses.
func TestGetAuth_UsernamePerProvider(t *testing.T) {
	for _, tc := range providerUsernames {
		g := NewGITWithToken("https://example.test/acme/repo.git", t.TempDir(), false, "tok-"+tc.provider, tc.provider)
		auth, err := g.getAuth()
		if err != nil {
			t.Fatalf("provider %q: getAuth: %v", tc.provider, err)
		}
		basic, ok := auth.(*githttp.BasicAuth)
		if !ok {
			t.Fatalf("provider %q: getAuth = %T, want *http.BasicAuth", tc.provider, auth)
		}
		if basic.Username != tc.want || basic.Password != "tok-"+tc.provider {
			t.Errorf("provider %q: BasicAuth = %s/%s, want %s/tok-%s", tc.provider, basic.Username, basic.Password, tc.want, tc.provider)
		}
	}
}

// TestClone_SendsTheProviderUsernameOnTheWire is the end-to-end half: what the server receives in
// the Authorization header of a real clone request, for each provider. The server answers 401, so
// the clone fails; the header it saw is the assertion.
func TestClone_SendsTheProviderUsernameOnTheWire(t *testing.T) {
	for _, tc := range providerUsernames[:3] {
		t.Run(tc.provider, func(t *testing.T) {
			var mu sync.Mutex
			var gotUser, gotPass string
			var sawAuth bool
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if u, p, ok := r.BasicAuth(); ok {
					mu.Lock()
					gotUser, gotPass, sawAuth = u, p, true
					mu.Unlock()
				}
				w.Header().Set("WWW-Authenticate", `Basic realm="test"`)
				w.WriteHeader(http.StatusUnauthorized)
			}))
			defer srv.Close()

			g := NewGITWithToken(srv.URL+"/acme/repo.git", t.TempDir(), false, "secret-"+tc.provider, tc.provider)
			if err := g.Clone(context.Background(), "", true); err == nil {
				t.Fatal("clone against a server that answers 401 succeeded")
			}
			mu.Lock()
			defer mu.Unlock()
			if !sawAuth {
				t.Fatal("the clone request carried no Basic credentials")
			}
			if gotUser != tc.want || gotPass != "secret-"+tc.provider {
				t.Errorf("server saw %s/%s, want %s/secret-%s", gotUser, gotPass, tc.want, tc.provider)
			}
		})
	}
}
