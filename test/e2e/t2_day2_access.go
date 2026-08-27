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
// day2AccessDefaultTimeout bounds the KUBE probes — reaching the apiserver and asking `can-i`.
// Those answer in seconds on a healthy cluster and never wait on a load balancer, so 3m is right
// and is unchanged.
//
// The URL probe is a different animal and now has its own ceiling; see day2URLDefaultTimeout. They
// were one knob, which is why raising the URL wait would have inflated a kube wait that had no
// reason to grow.
const day2AccessDefaultTimeout = 3 * time.Minute

// day2URLDefaultTimeout bounds the ArgoCD-URL probe alone.
//
// 3m could not cover the aws path BY CONSTRUCTION. The hostname only exists once an ALB is active,
// so the probe is waiting on ALB provisioning (2-4m on its own) BEFORE external-dns can publish
// anything, plus its reconcile interval and propagation. The old ceiling expired mid-chain every
// time, and the `dns-not-resolving` label then asserted that waiting would not help — which is how
// aws/byo run 32909287152 came to be read as a structural failure it was not.
//
// Raising a POLL ceiling is close to free, and it is the argument ArgoAssertTimeout already makes:
// the probe returns the moment the URL answers, so a larger budget costs time only on a genuinely
// broken cluster, while a budget smaller than the chain costs a real run its verdict. What it is
// NOT free of is the ctx — see t2_budget.go, where it is a RESERVED term rather than silent spend
// against headroom.
const day2URLDefaultTimeout = 10 * time.Minute

// Day2URLTimeout bounds the ArgoCD-URL probe. It shares ALETHIA_E2E_DAY2_ACCESS_TIMEOUT so an
// operator debugging by hand still has one knob, and falls back to its own default rather than the
// kube one.
func Day2URLTimeout() time.Duration {
	if v := strings.TrimSpace(os.Getenv("ALETHIA_E2E_DAY2_ACCESS_TIMEOUT")); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			return d
		}
	}
	return day2URLDefaultTimeout
}

func Day2AccessTimeout() time.Duration {
	if v := strings.TrimSpace(os.Getenv("ALETHIA_E2E_DAY2_ACCESS_TIMEOUT")); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			return d
		}
	}
	return day2AccessDefaultTimeout
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
	// ArgoURLDiagnosis is WHY an unreachable URL was unreachable, and it is the difference
	// between one run and two. #2591 recorded `argocd-url reachable=false` and nothing else,
	// which left "the DNS record was never written" and "the record is written and the ALB is
	// still coming up" indistinguishable — two different bugs with two different fixes, and the
	// only proposed discriminator was another paid run. The last probe error already existed
	// inside probeArgoURL; it simply never reached the summary. Empty on the reachable path.
	ArgoURLDiagnosis string `json:"argocd_url_diagnosis,omitempty"`
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
		if !s.ArgoURLReachable && s.ArgoURLDiagnosis != "" {
			argo += " — " + s.ArgoURLDiagnosis
		}
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

// diagnoseArgoURLError names WHY a URL probe failed, in the vocabulary of the thing that has to be
// fixed. It is PURE — a string classifier over the last error — so it is tested without a network.
//
// The point is to make one run answer the question two runs were about to be spent on (#2591):
//
//	dns-not-resolving   the hostname does not resolve. external-dns has not written the record
//	                    — which is a TIMING state early in the window and a real fault late in
//	                    it, and the label cannot tell them apart. See below.
//	connect-refused     it resolves, and nothing is listening. The record points at a load
//	                    balancer that is not serving yet — this IS a timing problem.
//	timeout             it resolves and the connection hangs. Typically a security group or an
//	                    ALB still registering targets; also a timing problem, different cause.
//	tls                 the connection is made and the certificate is rejected. The ACM
//	                    certificate is not attached to the listener, or does not cover the name.
//	http-<code>         it answered, and the answer was not one evaluateArgoURLStatus accepts.
//
// ⚠️ `dns-not-resolving` used to assert "NOT a timing problem; waiting longer will not fix it".
// That was never established, and it cost a wrong diagnosis: aws/byo run 32909287152 was read as a
// structural failure on that basis, when the run had a delegated public zone (ACM ISSUED a
// certificate against it, which requires the validation record to resolve publicly), external-dns
// deployed, and its IRSA role bound. Every precondition held; the record simply was not there yet
// at 3m. The serial chain before it can resolve is ALB active (2-4m on its own) -> Ingress gets a
// hostname -> external-dns reconciles (1m interval) -> Route53 write -> propagation. NXDOMAIN
// inside that window is the EXPECTED state, and is indistinguishable from a permanent fault by
// looking at the error alone. A label that decides whether to spend another run must not claim
// more than it knows.
//
// The default is UNCLASSIFIED and carries the error verbatim. A classifier that silently folded
// an unrecognised failure into the nearest known bucket would be worse than no classifier: the
// whole value here is that the label can be trusted to mean what it says.
func diagnoseArgoURLError(err error) string {
	if err == nil {
		return ""
	}
	msg := err.Error()
	switch {
	case strings.Contains(msg, "no such host"), strings.Contains(msg, "server misbehaving"),
		strings.Contains(msg, "NXDOMAIN"):
		return "dns-not-resolving: the hostname does not resolve — external-dns has not written the record yet. This is AMBIGUOUS: it is the expected state while the load balancer is still provisioning (nothing has a hostname for external-dns to publish), and it is also what a genuinely broken zone or domain-filter looks like. Distinguish by whether the probe budget covered the LB's provisioning time"
	case strings.Contains(msg, "connection refused"):
		return "connect-refused: the name resolves but nothing is listening — the target is not serving yet (a timing problem)"
	// BEFORE the certificate arm, deliberately. Go emits exactly "net/http: TLS handshake
	// timeout" (net/http/transport.go, tlsHandshakeTimeoutError), which contains no "tls:", no
	// "certificate" and no "x509" — so it used to reach the default and come back UNCLASSIFIED,
	// carrying no timing claim at all for a failure that is entirely about timing. Ordering it
	// first also means a future wrapped form that DOES read "tls: ... handshake timeout" cannot
	// be captured by the certificate arm, where it would assert the opposite advice: the two
	// labels disagree about whether waiting helps, and that decides the next run's budget.
	case strings.Contains(msg, "TLS handshake timeout"):
		return "tls-handshake-timeout: TCP connected but the handshake did not complete — the listener is up and not yet serving TLS, or the reply is being dropped (a timing problem)"
	case strings.Contains(msg, "certificate"), strings.Contains(msg, "tls:"),
		strings.Contains(msg, "x509"):
		// States what was OBSERVED and offers causes as candidates. An earlier wording named a
		// single cause — "the ACM certificate is not attached to the listener, or does not cover
		// this name" — which reads as a diagnosis the probe cannot support: a rejected
		// certificate is equally an expired one, an untrusted chain, or an SNI mismatch, and
		// on the clouds where cert-manager rather than ACM issues the certificate, ACM is not
		// even the mechanism. Its siblings state observations; this one asserted a conclusion.
		return "tls: the connection was made and the certificate was rejected — check that a certificate is attached to the listener and covers this name, is unexpired, and chains to a trusted root (waiting longer will NOT fix this)"
	case strings.Contains(msg, "context deadline exceeded"), strings.Contains(msg, "i/o timeout"),
		strings.Contains(msg, "Client.Timeout"):
		return "timeout: the name resolves and the connection hangs — typically a security group, or an ALB still registering targets (a timing problem)"
	// Mirrors evaluateArgoURLStatus's OWN wording. Matching a phrase the emitter never
	// produces is how a classifier reports UNCLASSIFIED for the one case it was written for,
	// so the test builds this error by CALLING that function rather than retyping its text.
	case strings.Contains(msg, "ArgoCD URL returned status"):
		return "http: the URL answered, and the status was not one the check accepts — " + msg
	default:
		return "UNCLASSIFIED: " + msg
	}
}

// probeArgoURL bounded-polls an HTTP GET of the ArgoCD URL until it RESOLVES (200 or a login
// redirect), or the timeout elapses. Redirects are NOT followed — a 3xx to /login is itself
// the reachability signal. Only meaningful where an ingress exists (AWS today).
func probeArgoURL(ctx context.Context, url string, timeout time.Duration) (ok bool, diagnosis string, err error) {
	deadline := time.Now().Add(timeout)
	var lastErr error
	attempts := 0
	for {
		attempts++
		code, gerr := httpGetStatus(ctx, url)
		if gerr == nil {
			if verr := evaluateArgoURLStatus(code); verr == nil {
				return true, "", nil
			} else {
				lastErr = verr
			}
		} else {
			lastErr = gerr
		}
		if time.Now().After(deadline) {
			// The attempt count is part of the evidence: "unreachable after 1 attempt" and
			// "unreachable after 36" say different things about whether the budget was the
			// binding constraint.
			d := fmt.Sprintf("%s (after %d attempt(s) over %s)", diagnoseArgoURLError(lastErr), attempts, timeout)
			return false, d, fmt.Errorf("ArgoCD URL %s did not resolve within %s: %v", url, timeout, lastErr)
		}
		select {
		case <-ctx.Done():
			d := fmt.Sprintf("%s (probe cancelled after %d attempt(s): %v)", diagnoseArgoURLError(lastErr), attempts, ctx.Err())
			return false, d, fmt.Errorf("context cancelled during ArgoCD URL probe (%v); last: %v", ctx.Err(), lastErr)
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

// ingressAddressVerdict turns the ArgoCD Ingress's load-balancer address into the sentence that
// makes a `dns-not-resolving` failure decidable.
//
// #2591 is the whole reason this exists. That diagnosis is honest but AMBIGUOUS, and says so: the
// hostname failing to resolve is BOTH the expected state while the load balancer is still coming up
// (nothing has an address for external-dns to publish) AND what a broken zone or domain filter
// looks like. Its proposed discriminator was another paid run at a longer timeout — which was run
// on 2026-08-27 (33056356388), failed identically after 61 attempts across 10 minutes, and still
// did not separate the two, because the budget was never the variable that mattered.
//
// The cluster already knows. If the Ingress has an address, external-dns had something to publish
// and did not — its problem. If it has none, external-dns is blameless and the bug is upstream in
// the ingress path. One read on an already-failing path replaces a whole class of re-runs.
//
// Pure, so the three outcomes are testable without a cluster: they are easy to collapse into each
// other and two of them point at different teams.
func ingressAddressVerdict(address string, err error) string {
	if err != nil {
		// "could not look" must never render like either verdict.
		return "ingress address UNKNOWN (could not read the Ingress: " + err.Error() + ") — this does NOT distinguish the two causes below"
	}
	if strings.TrimSpace(address) == "" {
		return "the ArgoCD Ingress has NO load-balancer address yet, so external-dns had nothing to publish — the fault is upstream in the ingress/load-balancer path, NOT in external-dns or the DNS zone"
	}
	return "the ArgoCD Ingress DOES have address " + strings.TrimSpace(address) +
		", so external-dns had something to publish and did not write the record — look at external-dns: its domain filter, its zone, and its cloud credentials"
}

// readIngressAddress reads the ArgoCD Ingress's assigned load-balancer address, if any.
//
// Best-effort and bounded: this runs only when the day-2 probe has ALREADY failed, so it must never
// be the reason a run hangs. An empty address with no error is a genuine finding, not a failure.
func readIngressAddress(ctx context.Context, kubeconfigPath string) (string, error) {
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cctx, "kubectl", "--kubeconfig", kubeconfigPath,
		"-n", "argocd", "get", "ingress",
		"-o", "jsonpath={.items[*].status.loadBalancer.ingress[*]['hostname','ip']}")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("%v: %s", err, strings.TrimSpace(string(out)))
	}
	return strings.TrimSpace(string(out)), nil
}
