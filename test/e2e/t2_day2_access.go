// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// T2 DAY-2 ACCESS surface (FULLY-TESTED P2-E) — the PURE, reusable half. Deliberately
// UNTAGGED (like controlplane.go / argocd_assert.go / t2_soak.go) so:
//
//   - `go mod tidy` sees its dependencies, and
//   - the derive / classify / verdict logic is unit-tested WITHOUT a cloud, a token, or the
//     e2e_t2 tag (t2_day2_access_pure_test.go).
//
// The A0.3 soak (t2_soak.go) proves the cluster is ALIVE (liveness / drift / PVC). It does
// NOT prove the SURFACED day-2 ACCESS path works — the gap that motivated the FULLY-TESTED
// bar: opening a cluster's :6443 returned a client-cert 401 (correct by design), but no
// usable access path was asserted. This surface closes that: it proves (a) the deploy
// SURFACED an access path (cluster_endpoint in the persisted execution_metadata — what the
// console reads), (b) the runner-written CLI-free kubeconfig (exec-plugin → kube-token)
// AUTHENTICATES and is AUTHORIZED for a real action (`kubectl auth can-i '*' '*'` → yes) —
// distinct from the soak's UNAUTHENTICATED /readyz liveness — over a real node read, and
// (c) where an ingress exists (AWS ALB+ACM today) the ArgoCD URL resolves. The
// orchestration that drives these against `*testing.T` + a live cluster lives in the
// e2e_t2-tagged t2_day2_access_run_test.go; nothing here imports `testing`.
//
// # How this assertion defends its own vacuity
//
//   - The access targets are DERIVED from the deploy's persisted execution_metadata (the
//     SAME cluster_endpoint / argocd_url the console surfaces), never hardcoded — so the
//     assertion cannot drift from what the deploy actually surfaced.
//   - An empty/missing cluster_endpoint is a HARD error in deriveAccessTargets: a deploy
//     that surfaced no access path must fail loudly, not assert over nothing.
//   - AUTHORIZED means the identity is admitted AND permitted — a reachable-but-401/403
//     cluster (the identity provisioned but not authorized: the AWS EKS access-entry #1040
//     class / the AKS AAD-admin-group caveat) FAILS the verdict, it does not slide by as
//     "reachable".
//   - The ArgoCD-URL check is per-cloud-gated like the soak's PVC check: argocd_url is
//     AWS-ALB+ACM-only today, so on gcp/azure ArgoURLChecked=false renders `n/a` and does
//     NOT gate the verdict — but where a URL WAS surfaced it MUST resolve.
//   - Every probe is BOUNDED (ALETHIA_E2E_DAY2_ACCESS_TIMEOUT, default 3m) so a
//     never-authorized identity fails loudly instead of hanging.
package e2e

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"
)

// day2PollInterval is how often the bounded access probes re-attempt (EKS access-entry / AKS
// AAD-admin propagation can lag a real apply by a poll or two, so a short poll is not wasted).
const day2PollInterval = 10 * time.Second

// Day2AccessEnabled reports whether this run should assert the day-2 ACCESS surface (opt-in;
// the nightly turns it on with the full bar).
func Day2AccessEnabled() bool {
	return os.Getenv("ALETHIA_E2E_DAY2_ACCESS") == "1"
}

// Day2AccessTimeout bounds each access probe — ALETHIA_E2E_DAY2_ACCESS_TIMEOUT when set (a Go
// duration), else 3m. Each probe returns the moment it succeeds, so the default only costs
// time on a genuinely inaccessible cluster.
func Day2AccessTimeout() time.Duration {
	if v := strings.TrimSpace(os.Getenv("ALETHIA_E2E_DAY2_ACCESS_TIMEOUT")); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			return d
		}
	}
	return 3 * time.Minute
}

// AccessTargets are the day-2 access artifacts a deploy surfaced, derived from its persisted
// execution_metadata. Endpoint is always required (a real cluster always resolves one);
// ArgoURL is present only where an ingress was configured (AWS today).
type AccessTargets struct {
	Endpoint   string
	ArgoURL    string
	HasArgoURL bool
}

// deriveAccessTargets reads the SURFACED access path from the deploy's persisted
// execution_metadata (cluster_endpoint + argocd_url — the SAME keys the deploy finalizer
// writes and the console renders). Fail-closed: an empty document, a parse failure, or a
// missing/blank cluster_endpoint is an error — a deploy that surfaced no access path must
// fail rather than let the assertion pass vacuously.
func deriveAccessTargets(metaRaw []byte) (AccessTargets, error) {
	if len(metaRaw) == 0 {
		return AccessTargets{}, errors.New("execution_metadata is empty — no day-2 access path to assert")
	}
	var meta struct {
		ClusterEndpoint string `json:"cluster_endpoint"`
		ArgocdURL       string `json:"argocd_url"`
	}
	if err := json.Unmarshal(metaRaw, &meta); err != nil {
		return AccessTargets{}, fmt.Errorf("decode execution_metadata: %w", err)
	}
	endpoint := strings.TrimSpace(meta.ClusterEndpoint)
	if endpoint == "" {
		return AccessTargets{}, errors.New("execution_metadata carries no cluster_endpoint — the deploy surfaced NO day-2 access path (the endpoint an operator's kubeconfig binds is missing); the access assertion would be vacuous")
	}
	url := strings.TrimSpace(meta.ArgocdURL)
	return AccessTargets{Endpoint: endpoint, ArgoURL: url, HasArgoURL: url != ""}, nil
}

// AccessSummary is the machine-readable result of the day-2 ACCESS assertion (P2-E), written
// to ALETHIA_E2E_DAY2_ACCESS_SUMMARY so the proof/verdict capture can fold an access line into
// the per-provider step summary. It carries only endpoints/URLs/booleans/counts — no secrets.
type AccessSummary struct {
	Enabled          bool   `json:"enabled"`
	Provider         string `json:"provider"`
	EndpointSurfaced bool   `json:"endpoint_surfaced"`
	Endpoint         string `json:"endpoint"`
	KubeReachable    bool   `json:"kube_reachable"`
	KubeAuthorized   bool   `json:"kube_authorized"`
	AuthAction       string `json:"auth_action"`
	ReadyNodes       int    `json:"ready_nodes"`
	ArgoURLChecked   bool   `json:"argocd_url_checked"`
	ArgoURL          string `json:"argocd_url"`
	ArgoURLReachable bool   `json:"argocd_url_reachable"`
	Verdict          string `json:"verdict"`
}

// accessVerdictPass reports whether every access check that RAN passed non-vacuously. The
// ArgoCD-URL check is per-cloud (AWS ingress today): when it did not run (ArgoURLChecked=false)
// it does not gate — but when it ran it MUST pass.
func accessVerdictPass(s AccessSummary) bool {
	if !s.Enabled {
		return false
	}
	base := s.EndpointSurfaced && s.KubeReachable && s.KubeAuthorized && s.ReadyNodes > 0
	if !base {
		return false
	}
	if s.ArgoURLChecked {
		return s.ArgoURLReachable
	}
	return true
}

// accessSummaryVerdict renders the one-line human verdict embedded in AccessSummary.Verdict.
func accessSummaryVerdict(s AccessSummary) string {
	if !s.Enabled {
		return "day2-access: skipped (ALETHIA_E2E_DAY2_ACCESS unset)"
	}
	icon := "✅"
	if !accessVerdictPass(s) {
		icon = "❌"
	}
	argo := "argocd-url: n/a (no ingress on this cloud yet — access via port-forward)"
	if s.ArgoURLChecked {
		argo = fmt.Sprintf("argocd-url reachable=%t (%s)", s.ArgoURLReachable, s.ArgoURL)
	}
	return fmt.Sprintf("%s day2-access: endpoint surfaced=%t · kube reachable=%t authorized=%t (can-i %s) · nodes ready=%d · %s",
		icon, s.EndpointSurfaced, s.KubeReachable, s.KubeAuthorized, s.AuthAction, s.ReadyNodes, argo)
}

// writeAccessSummary persists the access summary as indented JSON (no secrets — only
// endpoints/URLs/booleans/counts).
func writeAccessSummary(path string, s AccessSummary) error {
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(b, '\n'), 0o644)
}

// parseAuthCanI decodes `kubectl auth can-i` output — it prints "yes" when the action is
// permitted, "no" otherwise.
func parseAuthCanI(raw string) bool {
	return strings.EqualFold(strings.TrimSpace(raw), "yes")
}

// classifyCanI maps the combined output of `kubectl auth can-i '*' '*'` to (reachable,
// authorized). Pure + unit-tested. "yes" ⇒ authorized. A plain "no" or an auth rejection
// (401/403) means the apiserver ANSWERED (reachable) but the surfaced identity is not
// authorized — the AWS EKS access-entry (#1040) / AKS AAD-admin-group class. A dial/TLS/DNS
// error means the endpoint was not reachable at all. Network failures are checked FIRST so a
// "no such host" is never mistaken for the denial word "no".
func classifyCanI(out string) (reachable, authorized bool) {
	s := strings.ToLower(strings.TrimSpace(out))
	if s == "" {
		return false, false
	}
	for _, netErr := range []string{
		"unable to connect", "dial tcp", "no route to host", "i/o timeout",
		"connection refused", "connection timed out", "network is unreachable",
		"could not resolve", "no such host", "tls handshake timeout", "server timeout",
	} {
		if strings.Contains(s, netErr) {
			return false, false
		}
	}
	if parseAuthCanI(out) {
		return true, true
	}
	if strings.HasPrefix(s, "no") || strings.Contains(s, "unauthorized") ||
		strings.Contains(s, "forbidden") || strings.Contains(s, "must be logged in") {
		return true, false
	}
	// Unknown output — fail-closed (treat as not reachable so the verdict cannot pass).
	return false, false
}

// countReadyNodeLines counts the Ready nodes in `kubectl get nodes --no-headers` output —
// the same parse as HasReadyNode (controlplane.go), returning a count for the summary.
func countReadyNodeLines(nodes string) int {
	n := 0
	for _, line := range strings.Split(strings.TrimSpace(nodes), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 && fields[1] == "Ready" {
			n++
		}
	}
	return n
}

// evaluateArgoURLStatus is the PURE verdict over an ArgoCD-URL HTTP status: 200 (served) or a
// 3xx redirect (ArgoCD bounces an unauthenticated GET to /login) both prove the URL RESOLVES
// and the ingress is wired; anything else is a failure.
func evaluateArgoURLStatus(code int) error {
	if code == http.StatusOK || (code >= 300 && code < 400) {
		return nil
	}
	return fmt.Errorf("ArgoCD URL returned status %d (want 200 or a login redirect)", code)
}

// probeKubeAuthorized runs `kubectl --kubeconfig <kc> auth can-i '*' '*'` on a bounded poll
// until the surfaced identity is AUTHORIZED, or the timeout elapses. Returns the last
// (reachable, authorized) observation; a persistent auth rejection (reachable-but-401/403 —
// the #1040 / AKS-admin-group class) burns the timeout then fails with the classifier's
// verdict, so a red run is diagnosable from logs alone. Never mutates the cluster.
func probeKubeAuthorized(ctx context.Context, kubeconfigPath string, timeout time.Duration) (reachable, authorized bool, err error) {
	deadline := time.Now().Add(timeout)
	var lastOut string
	for {
		out := kubeAuthCanIOnce(ctx, kubeconfigPath)
		lastOut = out
		reachable, authorized = classifyCanI(out)
		if authorized {
			return true, true, nil
		}
		if time.Now().After(deadline) {
			return reachable, authorized, fmt.Errorf(
				"day-2 kube access is not authorized within %s (reachable=%t authorized=%t) — the surfaced kubeconfig's identity is admitted but not permitted (check the EKS access entry / AKS AAD-admin group ↔ the kube-token identity); last `auth can-i '*' '*'`:\n%s",
				timeout, reachable, authorized, strings.TrimSpace(lastOut))
		}
		select {
		case <-ctx.Done():
			return reachable, authorized, fmt.Errorf("context cancelled during day-2 kube access probe (%v); last output:\n%s", ctx.Err(), strings.TrimSpace(lastOut))
		case <-time.After(day2PollInterval):
		}
	}
}

// kubeAuthCanIOnce runs one `kubectl auth can-i '*' '*'` via an EXPLICIT kubeconfig (the
// tier's INDEPENDENT path — never the runner's side-effect KUBECONFIG env) and returns its
// combined output for classifyCanI. Bounded by its own short timeout under ctx.
func kubeAuthCanIOnce(ctx context.Context, kubeconfigPath string) string {
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cctx, "kubectl", "--kubeconfig", kubeconfigPath, "auth", "can-i", "*", "*")
	out, _ := cmd.CombinedOutput() // a denial exits non-zero; classifyCanI reads the text, not the code
	return string(out)
}

// probeReadyNodes reads the cluster's nodes via the surfaced kubeconfig and returns the Ready
// count — a real authorized read distinct from the auth-can-i check. One bounded attempt (node
// readiness was already asserted upstream by assertT2KubeconfigNodesReady); a zero/failed read
// here is a real day-2 access regression.
func probeReadyNodes(ctx context.Context, kubeconfigPath string) (int, error) {
	cctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cctx, "kubectl", "--kubeconfig", kubeconfigPath, "get", "nodes", "--no-headers")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return 0, fmt.Errorf("kubectl get nodes via the surfaced kubeconfig failed: %w\n%s", err, strings.TrimSpace(string(out)))
	}
	n := countReadyNodeLines(string(out))
	if n == 0 {
		return 0, fmt.Errorf("no Ready node via the surfaced kubeconfig:\n%s", strings.TrimSpace(string(out)))
	}
	return n, nil
}

// probeArgoURL bounded-polls an HTTP GET of the ArgoCD URL until it RESOLVES (200 or a login
// redirect), or the timeout elapses. Redirects are NOT followed — a 3xx to /login is itself
// the reachability signal. Only meaningful where an ingress exists (AWS today).
func probeArgoURL(ctx context.Context, url string, timeout time.Duration) (bool, error) {
	deadline := time.Now().Add(timeout)
	var lastErr error
	for {
		code, err := httpGetStatus(ctx, url)
		if err == nil {
			if verr := evaluateArgoURLStatus(code); verr == nil {
				return true, nil
			} else {
				lastErr = verr
			}
		} else {
			lastErr = err
		}
		if time.Now().After(deadline) {
			return false, fmt.Errorf("ArgoCD URL %s did not resolve within %s: %v", url, timeout, lastErr)
		}
		select {
		case <-ctx.Done():
			return false, fmt.Errorf("context cancelled during ArgoCD URL probe (%v); last: %v", ctx.Err(), lastErr)
		case <-time.After(day2PollInterval):
		}
	}
}

// httpGetStatus GETs a URL and returns the status code without following redirects (a 3xx is a
// valid reachability signal). Bounded by its own short timeout under ctx.
func httpGetStatus(ctx context.Context, url string) (int, error) {
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, err
	}
	client := &http.Client{
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	return resp.StatusCode, nil
}
