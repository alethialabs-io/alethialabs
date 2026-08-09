// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
)

// TestProbeDoesNotFollowRedirectToPlainHTTP is #2019's repro, kept.
//
// The https-only check applies to the URL we are GIVEN. Before the fix the probe then handed the
// request to http.DefaultClient, which follows up to 10 redirects with no CheckRedirect — so a single
// 302 from a customer-controlled repo URL reached any scheme and any host, and the returned boolean
// leaked whether that endpoint answered 200.
func TestProbeDoesNotFollowRedirectToPlainHTTP(t *testing.T) {
	var reached int32
	// The redirect TARGET: plain http, standing in for 169.254.169.254 or any internal service.
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&reached, 1)
		w.WriteHeader(http.StatusOK)
	}))
	defer target.Close()

	repo := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+"/info/refs", http.StatusFound)
	}))
	defer repo.Close()

	prev := probeHTTPClient
	probeHTTPClient = repo.Client()
	defer func() { probeHTTPClient = prev }()

	if got := IsRepoAnonymouslyCloneable(context.Background(), repo.URL); got {
		t.Error("IsRepoAnonymouslyCloneable = true via a redirect chain; a refused probe must fail closed to requiring a token")
	}
	if n := atomic.LoadInt32(&reached); n != 0 {
		t.Errorf("SSRF: the probe reached the plain-http redirect target %d time(s); the https-only guard is bypassed by a redirect", n)
	}
}

// TestProbeDoesNotFollowCrossHostRedirect covers the case the scheme check alone would miss: a
// redirect that stays on https but moves to another host. That is still SSRF (an internal service on
// 443), and it is also what a redirect-to-login looks like — which the doc comment always claimed
// returned false and, before the fix, did not.
func TestProbeDoesNotFollowCrossHostRedirect(t *testing.T) {
	var reached int32
	target := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&reached, 1)
		w.WriteHeader(http.StatusOK)
	}))
	defer target.Close()

	repo := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+"/info/refs", http.StatusFound)
	}))
	defer repo.Close()

	// A transport trusting BOTH servers, so the only thing that can stop the hop is the policy.
	prev := probeHTTPClient
	probeHTTPClient = &http.Client{Transport: &http.Transport{
		TLSClientConfig: repo.Client().Transport.(*http.Transport).TLSClientConfig.Clone(),
	}}
	probeHTTPClient.Transport.(*http.Transport).TLSClientConfig.InsecureSkipVerify = true
	defer func() { probeHTTPClient = prev }()

	if got := IsRepoAnonymouslyCloneable(context.Background(), repo.URL); got {
		t.Error("IsRepoAnonymouslyCloneable = true via a cross-host https redirect; want false")
	}
	if n := atomic.LoadInt32(&reached); n != 0 {
		t.Errorf("SSRF: the probe reached another host %d time(s) over https", n)
	}
}

// TestProbeFollowsSameHostRedirect is the other half, and it is not decoration: a policy that simply
// refused every redirect would pass both tests above while breaking a renamed-but-public repo, which
// is the common legitimate reason a git host answers 3xx.
func TestProbeFollowsSameHostRedirect(t *testing.T) {
	var srv *httptest.Server
	srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/moved") {
			http.Redirect(w, r, srv.URL+"/new/info/refs?service=git-upload-pack", http.StatusMovedPermanently)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	prev := probeHTTPClient
	probeHTTPClient = srv.Client()
	defer func() { probeHTTPClient = prev }()

	if got := IsRepoAnonymouslyCloneable(context.Background(), srv.URL+"/moved"); !got {
		t.Error("IsRepoAnonymouslyCloneable = false for a same-host redirect to a public repo; want true")
	}
}

// TestProbeStopsAfterMaxRedirects pins the cap. A same-host loop is allowed by the host rule, so
// without a bound the probe is a request amplifier pointed at whatever the customer names.
func TestProbeStopsAfterMaxRedirects(t *testing.T) {
	var hops int32
	var srv *httptest.Server
	srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hops, 1)
		http.Redirect(w, r, srv.URL+"/again", http.StatusFound)
	}))
	defer srv.Close()

	prev := probeHTTPClient
	probeHTTPClient = srv.Client()
	defer func() { probeHTTPClient = prev }()

	if got := IsRepoAnonymouslyCloneable(context.Background(), srv.URL); got {
		t.Error("IsRepoAnonymouslyCloneable = true on an endless redirect loop; want false")
	}
	if n := atomic.LoadInt32(&hops); n > maxProbeRedirects+1 {
		t.Errorf("probe made %d requests; the cap of %d redirects should have stopped it sooner", n, maxProbeRedirects)
	}
}

// TestProbeOrigin covers the comparison the redirect policy is built on, including the two cases the
// server-driven tests above cannot reach: an https URL with NO explicit port (every httptest URL has
// one) and a host differing only in case.
func TestProbeOrigin(t *testing.T) {
	cases := []struct{ in, want string }{
		{"https://example.com/org/repo", "example.com:443"},       // the default port is made explicit
		{"https://example.com:443/org/repo", "example.com:443"},   // …so both spellings compare equal
		{"https://EXAMPLE.com/org/repo", "example.com:443"},       // DNS is case-insensitive
		{"https://example.com:8443/org/repo", "example.com:8443"}, // a non-default port is a different origin
		{"https://169.254.169.254/latest/meta-data", "169.254.169.254:443"},
	}
	for _, c := range cases {
		u, err := url.Parse(c.in)
		if err != nil {
			t.Fatalf("parse %q: %v", c.in, err)
		}
		if got := probeOrigin(u); got != c.want {
			t.Errorf("probeOrigin(%q) = %q, want %q", c.in, got, c.want)
		}
	}

	// The property that matters: the two default-port spellings must not read as a cross-origin hop.
	a, _ := url.Parse("https://example.com/x")
	b, _ := url.Parse("https://example.com:443/y")
	if probeOrigin(a) != probeOrigin(b) {
		t.Error("example.com and example.com:443 compare as different origins; a legitimate redirect would be refused on a spelling difference")
	}
}

// TestProbeNeverMutatesTheSharedClient is the one that would have caught the tempting wrong fix:
// setting CheckRedirect on probeHTTPClient itself. It is http.DefaultClient in production, so that
// would silently change redirect behaviour for every other caller in the process.
func TestProbeNeverMutatesTheSharedClient(t *testing.T) {
	prev := probeHTTPClient
	shared := &http.Client{}
	probeHTTPClient = shared
	defer func() { probeHTTPClient = prev }()

	// Points nowhere; we only care about the side effect, not the result.
	_ = IsRepoAnonymouslyCloneable(context.Background(), "https://127.0.0.1:1/repo")

	if shared.CheckRedirect != nil {
		t.Error("the probe installed a CheckRedirect on the SHARED client; in production that is http.DefaultClient and every other caller inherits it")
	}
	if http.DefaultClient.CheckRedirect != nil {
		t.Error("http.DefaultClient.CheckRedirect was set process-wide")
	}
}
