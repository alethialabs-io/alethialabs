// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

//go:build e2e_t2

// Cross-account keyless CONTAINER REGISTRY in-cluster pull (#1047) — the ORCHESTRATION half.
// Compiled only under e2e_t2; every deterministic helper it calls lives in the untagged
// t2_xacct_registry.go so it stays unit-testable without a cloud.
package e2e

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

const (
	xacctRegistryRefresherTimeout = 6 * time.Minute
	xacctRegistryMintTimeout      = 6 * time.Minute
	xacctRegistryWorkloadTimeout  = 8 * time.Minute
	xacctRegistryDeniedWindow     = 3 * time.Minute
	xacctRegistryPollInterval     = 10 * time.Second
)

// xacctRegistryParams is what the T2 driver hands this layer.
type xacctRegistryParams struct {
	cfg     xacctRegistryConfig
	metaRaw []byte // the base DEPLOY's execution_metadata
}

// runT2XacctRegistry proves the in-cluster cross-account pull end to end, in the order that fails
// EARLIEST and most informatively:
//
//	(a) the deploy recorded NO fail-closed refresher skip — catches a missing B4 tofu output or a
//	    rejected connector before any cluster polling, and reports the runner's own reason. Read the
//	    caveat on xacctRegistryRenderSkips: this feature emits no POSITIVE decision record, so a
//	    clean (a) is the absence of a refusal and nothing more;
//	(b) the refresher Deployment is Available and its ServiceAccount carries this cloud's workload
//	    identity annotation — the cluster-side identity object, and where a broken B4 federation is
//	    visible without waiting on a pull to time out;
//	(c) the `<slug>-pull` Secret has been PATCHED with a real credential for the configured registry
//	    host — the mint, performed in-cluster with no local credential. This is the link the July
//	    mint e2e could not reach: it minted with ambient laptop credentials;
//	(d) a PRODUCT-rendered app pod actually pulled the cross-account image through that Secret — the
//	    claim itself. Without it, (c) proves a token was produced, not that anything consumed it;
//	(e) the NEGATIVE control: the SAME image, same namespace, NO pull secret, must NOT pull — or (d)
//	    proves only that a registry served an image to anyone who asked.
func runT2XacctRegistry(t *testing.T, ctx context.Context, kc string, p xacctRegistryParams) {
	t.Helper()
	summary := xacctRegistrySummary{
		Provider:     p.cfg.provider,
		Slug:         p.cfg.connectorSlug(),
		RegistryHost: p.cfg.host,
		PullSecret:   p.cfg.pullSecretName(),
		TargetRef:    p.cfg.targetRef(),
		Image:        p.cfg.image,
		Verdict:      "FAIL",
	}
	defer func() { writeXacctRegistrySummary(t, p.cfg, summary) }()

	// (a) The runner's fail-closed skips.
	skips, err := xacctRegistryRenderSkips(p.metaRaw)
	if err != nil {
		t.Fatalf("xacct-registry: %v", err)
	}
	if len(skips) > 0 {
		t.Fatalf("the deploy REFUSED to render the cross-account pull refresher:\n  %s", strings.Join(skips, "\n  "))
	}
	summary.RefresherRendered = true
	t.Logf("xacct-registry: the deploy recorded no fail-closed refresher skip (absence of a refusal — the refresher's existence is proven below, not here)")

	// (b) The refresher and its federated identity.
	awaitXacctRegistryRefresher(t, ctx, kc, p)
	summary.IdentityAnnotated = assertRefresherIdentity(t, ctx, kc, p)

	// (c) The mint: the pull Secret carries a real credential for this host.
	awaitPullSecretMinted(t, ctx, kc, p)
	summary.SecretMinted = true

	// (d) A product-rendered pod pulled the cross-account image through it.
	assertXacctImagePulled(t, ctx, kc, p)
	summary.ImagePulled = true

	// (e) The negative control.
	summary.ScopeDenied = assertUnauthenticatedPullDenied(t, ctx, kc, p)

	summary.Verdict = "PASS"
}

// awaitXacctRegistryRefresher polls the standalone refresher Deployment until Available.
//
// The refresher is a Deployment rather than a sidecar because a pull Secret must exist BEFORE any app
// pod schedules — so this necessarily converges first, and a failure here is a failure to render or
// to start, never a failure to pull.
func awaitXacctRegistryRefresher(t *testing.T, ctx context.Context, kc string, p xacctRegistryParams) {
	t.Helper()
	deadline := time.Now().Add(xacctRegistryRefresherTimeout)
	var last kubeCondition
	for time.Now().Before(deadline) {
		out, err := nsKubectl(ctx, kc, "get", "deployment", registryPullKSA, "-n", p.cfg.namespace, "-o", "json")
		if err == nil {
			cond, ok, perr := deploymentAvailable([]byte(out))
			if perr == nil {
				last = cond
				if ok {
					t.Logf("xacct-registry: the %s refresher Deployment is Available in %s", registryPullKSA, p.cfg.namespace)
					return
				}
			}
		}
		select {
		case <-ctx.Done():
			t.Fatalf("xacct-registry: context cancelled waiting for deployment/%s (last: %+v)", registryPullKSA, last)
		case <-time.After(xacctRegistryPollInterval):
		}
	}
	dumpXacctRegistryDiagnostics(t, ctx, kc, p)
	t.Fatalf("xacct-registry: the refresher deployment/%s never became Available within %s (last condition: %+v). "+
		"With ALETHIA_XACCT_REGISTRY_ENABLED=true and a keyless registry selected the product renders it into the apps repo, "+
		"so an absent Deployment means it was never rendered and an unhealthy one means the runner image could not start the registry-token loop",
		registryPullKSA, xacctRegistryWorkloadTimeout, last)
}

// assertRefresherIdentity checks the cluster-side identity object: the refresher's ServiceAccount must
// exist AND carry this cloud's workload-identity annotation, which the B4 tofu pull role's output
// supplies. An unannotated KSA is the single most common way federation silently does not happen —
// the Deployment runs, the loop starts, and every mint is refused for reasons about credentials
// rather than about trust.
//
// It reuses keylessIdentityAnnotation (#1511) deliberately: the annotation each cloud's identity
// webhook keys on is a property of the CLOUD, not of the feature, and a second copy here would be a
// second literal to drift.
func assertRefresherIdentity(t *testing.T, ctx context.Context, kc string, p xacctRegistryParams) bool {
	t.Helper()
	want := keylessIdentityAnnotation(p.cfg.provider)
	out, err := nsKubectl(ctx, kc, "get", "serviceaccount", registryPullKSA, "-n", p.cfg.namespace,
		"-o", "jsonpath={.metadata.annotations."+strings.ReplaceAll(want, ".", `\.`)+"}")
	if err != nil {
		t.Fatalf("the refresher ServiceAccount %s/%s does not exist — the product emits it with the refresher, so the pod has no identity to federate: %v", p.cfg.namespace, registryPullKSA, err)
	}
	if strings.TrimSpace(out) == "" {
		t.Fatalf("ServiceAccount %s/%s carries no %s annotation — the B4 tofu pull-identity output never reached it, so the refresher runs as an identity the target account cannot trust",
			p.cfg.namespace, registryPullKSA, want)
	}
	t.Logf("xacct-registry: ServiceAccount %s/%s carries %s (the cluster-side identity the target account trusts)", p.cfg.namespace, registryPullKSA, want)
	return true
}

// awaitPullSecretMinted polls the `<slug>-pull` Secret until it carries a real credential for the
// configured registry host — the moment the in-cluster mint succeeded.
//
// The token is never read out, logged or returned: assertPullSecretMinted answers a boolean and, on a
// wrong-host mint, names only the hosts. A misdirected mint fails IMMEDIATELY rather than polling to
// the deadline, because no amount of waiting turns auth for one registry into auth for another.
func awaitPullSecretMinted(t *testing.T, ctx context.Context, kc string, p xacctRegistryParams) {
	t.Helper()
	secret := p.cfg.pullSecretName()
	deadline := time.Now().Add(xacctRegistryMintTimeout)
	var lastErr string
	for time.Now().Before(deadline) {
		out, err := nsKubectl(ctx, kc, "get", "secret", secret, "-n", p.cfg.namespace, "-o", "json")
		if err == nil {
			minted, merr := assertPullSecretMinted([]byte(out), p.cfg.host)
			if merr != nil {
				dumpXacctRegistryDiagnostics(t, ctx, kc, p)
				t.Fatalf("xacct-registry: %v", merr)
			}
			if minted {
				t.Logf("xacct-registry: %s/%s carries a minted credential for %s — the refresher authenticated to the target account from inside the cluster with NO stored key",
					p.cfg.namespace, secret, p.cfg.host)
				return
			}
			lastErr = "still the empty placeholder ({\"auths\":{}}) — the refresher has not minted yet"
		} else {
			lastErr = err.Error()
		}
		select {
		case <-ctx.Done():
			t.Fatalf("xacct-registry: context cancelled waiting for %s/%s to be minted (last: %s)", p.cfg.namespace, secret, lastErr)
		case <-time.After(xacctRegistryPollInterval):
		}
	}
	dumpXacctRegistryDiagnostics(t, ctx, kc, p)
	t.Fatalf("xacct-registry: %s/%s was never patched with a credential for %s within %s (last: %s) — the refresher started but its mint never succeeded; the registry-token container log above carries the target account's own refusal",
		p.cfg.namespace, secret, p.cfg.host, xacctRegistryMintTimeout, lastErr)
}

// assertXacctImagePulled is the claim itself: a PRODUCT-rendered workload, carrying the
// product-attached imagePullSecret, running the cross-account image.
//
// Deliberately NOT a hand-authored pod. Authoring one with an explicit imagePullSecrets would prove
// that Kubernetes honours a dockerconfigjson — which was never in doubt — rather than that Alethia
// wires a cross-account registry selection through to the pods it generates.
func assertXacctImagePulled(t *testing.T, ctx context.Context, kc string, p xacctRegistryParams) {
	t.Helper()
	deploy := awaitXacctProbeWorkload(t, ctx, kc, p)
	view, err := parsePodSpecView(deploy)
	if err != nil {
		t.Fatalf("xacct-registry: %v", err)
	}
	secret := p.cfg.pullSecretName()
	if !view.hasPullSecret(secret) {
		t.Fatalf("the rendered pod attaches imagePullSecrets %v, which does not include %q — the registry selection never reached the generated workload, so whatever pulled did so without the platform's credential",
			view.ImagePullSecrets, secret)
	}
	if !view.hasImage(p.cfg.image) {
		t.Fatalf("the rendered pod runs %v, not the configured cross-account image %q — the run would prove a pull from somewhere else entirely", view.Images, p.cfg.image)
	}
	t.Logf("xacct-registry: deployment/%s is Available running %s with imagePullSecret %s — a pod in this cluster pulled an image out of the target account", p.cfg.serviceName, p.cfg.image, secret)
}

// awaitXacctProbeWorkload polls the product-rendered probe Deployment until Available, failing FAST
// and specifically on a pull failure.
//
// An ImagePullBackOff is the outcome this scenario exists to detect, and it is terminal in practice —
// waiting the full timeout to report "never became Available" would bury the kubelet's message, which
// is the entire diagnosis (a repository policy that does not name the pull identity, a wrong host, a
// token minted for a different account).
func awaitXacctProbeWorkload(t *testing.T, ctx context.Context, kc string, p xacctRegistryParams) []byte {
	t.Helper()
	deadline := time.Now().Add(xacctRegistryWorkloadTimeout)
	var last kubeCondition
	for time.Now().Before(deadline) {
		out, err := nsKubectl(ctx, kc, "get", "deployment", p.cfg.serviceName, "-n", p.cfg.namespace, "-o", "json")
		if err == nil {
			cond, ok, perr := deploymentAvailable([]byte(out))
			if perr == nil {
				last = cond
				if ok {
					return []byte(out)
				}
			}
		}
		if st, ok := xacctProbePullFailure(ctx, kc, p); ok {
			dumpXacctRegistryDiagnostics(t, ctx, kc, p)
			t.Fatalf("xacct-registry: the probe pod could NOT pull %s (%s): %s — the cross-account pull failed with the platform's own credential attached",
				p.cfg.image, st.Reason, st.Message)
		}
		select {
		case <-ctx.Done():
			t.Fatalf("xacct-registry: context cancelled waiting for deployment/%s (last: %+v)", p.cfg.serviceName, last)
		case <-time.After(xacctRegistryPollInterval):
		}
	}
	dumpXacctRegistryDiagnostics(t, ctx, kc, p)
	t.Fatalf("xacct-registry: deployment/%s never became Available within %s (last condition: %+v)", p.cfg.serviceName, xacctRegistryWorkloadTimeout, last)
	return nil
}

// xacctProbePullFailure reports whether any pod of the probe workload is stuck on an image pull.
func xacctProbePullFailure(ctx context.Context, kc string, p xacctRegistryParams) (pullState, bool) {
	out, err := nsKubectl(ctx, kc, "get", "pods", "-n", p.cfg.namespace,
		"-l", keylessSelector+"="+p.cfg.serviceName, "-o", "json")
	if err != nil {
		return pullState{}, false
	}
	var list struct {
		Items []map[string]any `json:"items"`
	}
	if json.Unmarshal([]byte(out), &list) != nil {
		return pullState{}, false
	}
	for _, item := range list.Items {
		raw, merr := json.Marshal(item)
		if merr != nil {
			continue
		}
		st, perr := parsePullState(raw)
		if perr == nil && st.Failed {
			return st, true
		}
	}
	return pullState{}, false
}

// assertUnauthenticatedPullDenied is the NEGATIVE control for the whole scenario: the SAME image, in
// the SAME namespace, with NO imagePullSecrets, must not pull.
//
// It first proves the control is not VOID: if the namespace's default ServiceAccount carried the pull
// Secret, every pod would get the credential implicitly and "no imagePullSecrets" would change
// nothing. That is a product-shaped failure, so it fails rather than merely warns.
//
// The registry's error WORDING is logged, never matched: it is provider- and version-specific, and
// asserting on it would make a message change look like a security regression. What is asserted is
// behavioural — the image does not arrive.
func assertUnauthenticatedPullDenied(t *testing.T, ctx context.Context, kc string, p xacctRegistryParams) bool {
	t.Helper()
	saJSON, err := nsKubectl(ctx, kc, "get", "serviceaccount", "default", "-n", p.cfg.namespace, "-o", "json")
	if err != nil {
		t.Fatalf("xacct-registry: cannot read the default ServiceAccount, so the negative control cannot be shown to be meaningful: %v", err)
	}
	saSecrets, err := parseServiceAccountPullSecrets([]byte(saJSON))
	if err != nil {
		t.Fatalf("xacct-registry: %v", err)
	}
	if len(saSecrets) > 0 {
		t.Fatalf("the default ServiceAccount in %s attaches imagePullSecrets %v — every pod in the namespace would inherit a pull credential, which makes this negative control VOID rather than merely weak",
			p.cfg.namespace, saSecrets)
	}

	applyKube(t, ctx, kc, buildUnauthenticatedPullPod(xacctRegistryDeniedPod, p.cfg.namespace, p.cfg.image))
	t.Cleanup(func() {
		_, _ = nsKubectl(context.Background(), kc, "delete", "pod", xacctRegistryDeniedPod, "-n", p.cfg.namespace, "--wait=false", "--ignore-not-found")
	})

	deadline := time.Now().Add(xacctRegistryDeniedWindow)
	for time.Now().Before(deadline) {
		out, err := nsKubectl(ctx, kc, "get", "pod", xacctRegistryDeniedPod, "-n", p.cfg.namespace, "-o", "json")
		if err == nil {
			st, perr := parsePullState([]byte(out))
			if perr == nil {
				if st.Pulled {
					t.Fatalf("SCOPE LEAK: a pod with NO imagePullSecrets pulled %s — the cross-account image is reachable without the credential the platform mints, so the positive proof shows only that a registry served an image",
						p.cfg.image)
				}
				if st.Failed {
					t.Logf("xacct-registry: the unauthenticated pull was refused, as required (reason=%s, registry message logged not matched): %s", st.Reason, st.Message)
					return true
				}
			}
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(xacctRegistryPollInterval):
		}
	}
	// Neither pulled nor an observed failure within the window. That is NOT a pass: an image that
	// never arrived and never errored is an unfinished observation, and recording it as a denial
	// would be exactly the "green that proves nothing" this scenario was written to end.
	dumpXacctRegistryDiagnostics(t, ctx, kc, p)
	t.Fatalf("xacct-registry: the unauthenticated probe neither pulled nor reported a pull failure within %s — the negative control is INCONCLUSIVE, so the run cannot claim the credential was required",
		xacctRegistryDeniedWindow)
	return false
}

// dumpXacctRegistryDiagnostics prints what an operator would look at first. The refresher's own log
// carries the target account's refusal verbatim (an AssumeRole denial, an artifactregistry.reader
// that was never granted, an ACR that does not know the client id) — the registry-token loop prints
// the error and keeps the last good Secret, so nothing else surfaces it.
func dumpXacctRegistryDiagnostics(t *testing.T, ctx context.Context, kc string, p xacctRegistryParams) {
	t.Helper()
	if out, err := nsKubectl(ctx, kc, "logs", "-n", p.cfg.namespace,
		"deployment/"+registryPullKSA, "-c", "registry-token", "--tail=100"); err == nil {
		t.Logf("xacct-registry: registry-token refresher logs (tail):\n%s", out)
	}
	if out, err := nsKubectl(ctx, kc, "describe", "deployment", registryPullKSA, "-n", p.cfg.namespace); err == nil {
		t.Logf("xacct-registry: describe deployment/%s:\n%s", registryPullKSA, out)
	}
	if out, err := nsKubectl(ctx, kc, "describe", "pods", "-n", p.cfg.namespace,
		"-l", keylessSelector+"="+p.cfg.serviceName); err == nil {
		t.Logf("xacct-registry: describe probe pods:\n%s", out)
	}
	if out, err := nsKubectl(ctx, kc, "describe", "pod", xacctRegistryDeniedPod, "-n", p.cfg.namespace); err == nil {
		t.Logf("xacct-registry: describe the unauthenticated probe:\n%s", out)
	}
}

// writeXacctRegistrySummary folds the machine-readable verdict into the proof bundle. Best-effort: a
// summary-write failure must not mask the real assertion outcome.
func writeXacctRegistrySummary(t *testing.T, c xacctRegistryConfig, s xacctRegistrySummary) {
	t.Helper()
	if c.summaryPath == "" {
		return
	}
	b, err := xacctRegistrySummaryJSON(s)
	if err != nil {
		t.Logf("xacct-registry: could not render the summary: %v", err)
		return
	}
	if err := os.WriteFile(c.summaryPath, b, 0o644); err != nil {
		t.Logf("xacct-registry: could not write the summary to %s: %v", c.summaryPath, err)
	}
}
