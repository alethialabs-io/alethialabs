// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"context"
	"io"
	"net/http"
	"strings"
	"time"
)

// repoProbeTimeout bounds the anonymous-clone probe so a slow or unreachable git host can't stall
// the deploy. A probe that times out is treated as "not anonymously cloneable" (fail-closed to
// requiring a token).
const repoProbeTimeout = 10 * time.Second

// probeHTTPClient performs the anonymous ref-advertisement request. A package var (not http.DefaultClient
// inline) only so tests can point it at a TLS test server; production always uses the default client.
var probeHTTPClient = http.DefaultClient

// IsRepoAnonymouslyCloneable reports whether a git repo can be cloned WITHOUT credentials, by making
// the same unauthenticated request `git clone` opens with: GET <repo>/info/refs?service=git-upload-pack,
// the git smart-HTTP ref-advertisement handshake. A public repo answers 200; a private one answers
// 401/403 (GitHub and GitLab both reject the anonymous ref advertisement for private repos). ArgoCD
// clones a public apps repo anonymously — proven on kind against the public enterprise-demo — so when
// this returns true the deploy needs no git token at all.
//
// Fail-closed by construction: only https URLs are probed (ssh/git/http → false), and any error,
// timeout, redirect-to-login, or non-200 → false (require a token). A private repo therefore can never
// be mistaken for public; the worst a wrong probe can do is demand a token that turned out optional.
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
	resp, err := probeHTTPClient.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	// 200 = the server served the ref advertisement anonymously → a keyless clone works.
	return resp.StatusCode == http.StatusOK
}
