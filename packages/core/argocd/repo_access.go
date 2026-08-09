// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// repoProbeTimeout bounds the anonymous-clone probe so a slow or unreachable git host can't stall
// the deploy. A probe that times out is treated as "not anonymously cloneable" (fail-closed to
// requiring a token).
const repoProbeTimeout = 10 * time.Second

// probeHTTPClient performs the anonymous ref-advertisement request. A package var (not http.DefaultClient
// inline) only so tests can point it at a TLS test server; production always uses the default client.
//
// Its redirect policy is NOT read — probeClient() below rebuilds a client around this one's Transport
// and installs checkProbeRedirect unconditionally. That is deliberate: the seam exists to supply TLS
// trust, and a test (or a future caller) swapping in a plain &http.Client must not be able to silently
// drop the SSRF guard with it.
var probeHTTPClient = http.DefaultClient

// maxProbeRedirects bounds the redirect chain. Even an all-same-host chain is a request amplifier, and
// a public git host needs one or two hops at most (a rename, a trailing-slash normalisation).
const maxProbeRedirects = 3

// checkProbeRedirect refuses any redirect that leaves https or leaves the host we were pointed at.
//
// The repo URL is customer-controlled project data and this probe runs ON THE RUNNER, inside the
// deploy's network position — the runner-parent SSRF shape. Before this, the `https://` check applied
// only to the URL we were GIVEN: one 302 sent http.DefaultClient (10 hops, no policy) to any scheme and
// any host, including plain http:// and 169.254.169.254, and the returned boolean leaked whether that
// endpoint answered 200.
//
// Same-host redirects are still followed, so a renamed-but-public repo keeps working. Cross-host is
// what SSRF requires and what a redirect-to-login does, and both are refused — matching the fail-closed
// contract this function's doc comment already promised but did not implement.
func checkProbeRedirect(req *http.Request, via []*http.Request) error {
	if len(via) >= maxProbeRedirects {
		return fmt.Errorf("stopped after %d redirects", maxProbeRedirects)
	}
	if req.URL.Scheme != "https" {
		return fmt.Errorf("refusing redirect to non-https scheme %q", req.URL.Scheme)
	}
	// via[0] is the original request; comparing against it (not the immediate predecessor) stops a
	// chain from walking host-by-host to somewhere the first hop would never have been allowed.
	//
	// Host AND port, not just the hostname: same-name-different-port is a pivot onto a different
	// service (an admin UI or a metrics endpoint on the same box), and the hostname alone would wave
	// it through. A test redirecting between two httptest servers — both on 127.0.0.1, different
	// ports — is exactly that shape, and it caught this.
	if origin, to := probeOrigin(via[0].URL), probeOrigin(req.URL); origin != to {
		return fmt.Errorf("refusing cross-origin redirect from %q to %q", origin, to)
	}
	return nil
}

// probeOrigin renders a URL's origin as host:port, lowercased, with https's default port made
// explicit so `example.com` and `example.com:443` compare equal rather than failing closed on a
// spelling difference.
func probeOrigin(u *url.URL) string {
	port := u.Port()
	if port == "" {
		port = "443"
	}
	return strings.ToLower(u.Hostname()) + ":" + port
}

// probeClient returns the client the probe actually uses: probeHTTPClient's Transport (the test seam)
// with the redirect policy welded on. Never mutates probeHTTPClient — it is usually http.DefaultClient,
// and setting CheckRedirect on that would change redirect behaviour for every other caller in the
// process.
func probeClient() *http.Client {
	return &http.Client{
		Transport:     probeHTTPClient.Transport,
		CheckRedirect: checkProbeRedirect,
	}
}

// IsRepoAnonymouslyCloneable reports whether a git repo can be cloned WITHOUT credentials, by making
// the same unauthenticated request `git clone` opens with: GET <repo>/info/refs?service=git-upload-pack,
// the git smart-HTTP ref-advertisement handshake. A public repo answers 200; a private one answers
// 401/403 (GitHub and GitLab both reject the anonymous ref advertisement for private repos). ArgoCD
// clones a public apps repo anonymously — proven on kind against the public enterprise-demo — so when
// this returns true the deploy needs no git token at all.
//
// Fail-closed by construction: only https URLs are probed (ssh/git/http → false); redirects may not
// leave https or leave the original host, and are capped at maxProbeRedirects (see checkProbeRedirect);
// and any error, timeout, refused redirect, or non-200 → false (require a token). A private repo
// therefore can never be mistaken for public; the worst a wrong probe can do is demand a token that
// turned out optional.
// No credential is ever sent (the probe is anonymous, exactly like git's first fetch), so the token
// gate is only ever RELAXED for a repo the world can already read.
func IsRepoAnonymouslyCloneable(ctx context.Context, repoURL string) bool {
	u := strings.TrimSuffix(strings.TrimRight(strings.TrimSpace(repoURL), "/"), ".git")
	// Only smart-HTTP over TLS is probeable AND safe to probe (an http:// or internal URL would widen
	// the SSRF surface beyond the clone ArgoCD already performs); ssh/git:// always require a token.
	if !strings.HasPrefix(u, "https://") {
		return false
	}
	reqCtx, cancel := context.WithTimeout(ctx, repoProbeTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, u+"/info/refs?service=git-upload-pack", nil)
	if err != nil {
		return false
	}
	resp, err := probeClient().Do(req)
	if err != nil {
		// Includes every refusal from checkProbeRedirect, so a redirect off https or off the host
		// lands here and reports "not anonymously cloneable" — a token is required.
		return false
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	// 200 = the server served the ref advertisement anonymously → a keyless clone works.
	return resp.StatusCode == http.StatusOK
}
