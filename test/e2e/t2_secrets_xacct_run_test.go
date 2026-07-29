// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

//go:build e2e_t2

// Cross-account keyless cloud-secret-manager in-cluster read (#1268) — the ORCHESTRATION half.
// Compiled only under e2e_t2; every deterministic helper it calls lives in the untagged
// t2_secrets_xacct.go so it stays unit-testable without a cloud.
package e2e

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/manifests"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

const (
	xacctStoreReadyTimeout  = 3 * time.Minute
	xacctSecretSyncTimeout  = 5 * time.Minute
	xacctDeniedProbeWindow  = 90 * time.Second
	xacctPollInterval       = 10 * time.Second
	xacctDeniedPollInterval = 15 * time.Second
)

// secretsXacctParams is what the T2 driver hands this layer.
type secretsXacctParams struct {
	cfg     secretsXacctConfig
	metaRaw []byte // the base DEPLOY's execution_metadata
}

// runT2SecretsXacct proves the cross-account read end to end, in the order that fails EARLIEST and
// most informatively:
//
//	(a) the deploy's own decision record says the store was installed — catches a missing identity
//	    fact before any cluster polling, and reports the runner's own reason for the skip;
//	(b) the ClusterSecretStore reaches Ready — ESO validates the store's auth here, so an STS/trust
//	    misconfiguration surfaces with the provider's real error message, the highest-signal point
//	    in the whole flow;
//	(c) the PRODUCT-rendered ExternalSecret reaches Ready — this is the link #1268 exists to prove
//	    (the store existing proves nothing about a workload reading through it);
//	(d) the materialized Secret's value matches the canary's sha256 — without this the test could
//	    watch an empty Secret appear and call it a pass;
//	(e) the NEGATIVE control: the same read from a namespace labelled alethia.io/placement=namespace
//	    must NOT sync, proving #1306's tenant scoping is real.
func runT2SecretsXacct(t *testing.T, ctx context.Context, kc string, p secretsXacctParams) {
	t.Helper()
	summary := xacctSummary{
		Provider:  p.cfg.provider,
		Slug:      p.cfg.connectorSlug(),
		Store:     p.cfg.storeName(),
		TargetRef: p.cfg.roleARN,
		RemoteKey: p.cfg.remoteKey,
		Verdict:   "FAIL",
	}
	defer func() { writeXacctSummary(t, p.cfg, summary) }()

	// (a) The runner's own decision record. A `skipped` here means the deploy never applied the
	// store, and the recorded reason names which half of the gate was missing.
	status, reason := xacctDecision(t, p.metaRaw)
	switch status {
	case "":
		t.Fatalf("no external-secrets-store-xacct decision in execution_metadata — the DEPLOY snapshot did not carry a cross-account secret (check applyToSnapshot ordering vs MaxConfigSnapshot)")
	case "skipped":
		t.Fatalf("the runner SKIPPED the cross-account store: %s", reason)
	case "installed":
		t.Logf("xacct: runner recorded the store installed — %s", reason)
	default:
		t.Fatalf("unexpected external-secrets-store-xacct status %q (%s)", status, reason)
	}

	// (b) Store validation. ESO surfaces the assume/trust failure here with the provider's message.
	cond := waitKubeReady(t, ctx, kc, "clustersecretstore", "", p.cfg.storeName(), xacctStoreReadyTimeout)
	summary.StoreReady = true
	t.Logf("xacct: %s is Ready (reason=%s)", p.cfg.storeName(), cond.Reason)

	// (c) The PRODUCT-rendered ExternalSecret. Deliberately NOT hand-authored: authoring it here
	// would prove ESO works, not that Alethia wires a project secret to a cross-account store.
	esName := xacctBindingSecretName(p.cfg)
	cond = waitKubeReady(t, ctx, kc, "externalsecret", p.cfg.probeNS, esName, xacctSecretSyncTimeout)
	summary.SecretSynced = true
	t.Logf("xacct: ExternalSecret %s/%s synced (reason=%s)", p.cfg.probeNS, esName, cond.Reason)

	// (d) The value actually crossed the account boundary.
	raw := nsKubectlOut(t, ctx, kc, "get", "secret", esName, "-n", p.cfg.probeNS, "-o", "json")
	if err := assertSecretValueSHA(raw, secretsXacctDataKey, p.cfg.expectSHA256); err != nil {
		t.Fatalf("xacct: %v", err)
	}
	summary.ValueMatched = true
	t.Logf("xacct: materialized value matches the canary sha256 — a workload in this cluster read a secret from the target account with no credential")

	// (e) The negative control.
	summary.ScopeDenied = assertXacctScopeDenied(t, ctx, kc, p.cfg)

	summary.Verdict = "PASS"
}

// xacctDecision reads the external-secrets-store-xacct decision out of execution_metadata.
func xacctDecision(t *testing.T, metaRaw []byte) (status, reason string) {
	t.Helper()
	var meta struct {
		InfraServices []struct {
			Service string `json:"service"`
			Status  string `json:"status"`
			Reason  string `json:"reason"`
		} `json:"infra_services"`
	}
	if err := json.Unmarshal(metaRaw, &meta); err != nil {
		t.Fatalf("decode execution_metadata: %v", err)
	}
	for _, d := range meta.InfraServices {
		if d.Service == "external-secrets-store-xacct" {
			return d.Status, d.Reason
		}
	}
	return "", ""
}

// xacctBindingSecretName is the name of BOTH the rendered ExternalSecret and the Secret it
// materializes. It calls the PRODUCT's namer rather than reimplementing it: BindingSecretName
// applies dns1123 normalization, so a hand-rolled "<svc>-secret-<name>" would silently disagree the
// first time a name needed normalizing, and the test would poll for an object that never appears.
func xacctBindingSecretName(c secretsXacctConfig) string {
	return manifests.BindingSecretName(c.serviceName, types.ServiceBindingTarget{
		Kind: types.ServiceBindingKindSecret,
		Name: c.secretName,
	})
}

// waitKubeReady polls a namespaced or cluster-scoped object until its ESO `Ready` condition is True.
//
// A MISSING Ready condition means "not reconciled yet" and keeps polling; only Ready=False or the
// timeout fails. On failure it dumps the object's describe output and the operator's logs, because
// the useful diagnosis (an STS AccessDenied, a wrong region, an unregistered OIDC provider) lives in
// the condition message and the controller log, not in the test's own assertion.
func waitKubeReady(t *testing.T, ctx context.Context, kc, kind, ns, name string, timeout time.Duration) esCondition {
	t.Helper()
	args := []string{"get", kind, name, "-o", "json"}
	if ns != "" {
		args = append(args, "-n", ns)
	}
	deadline := time.Now().Add(timeout)
	var last esCondition
	var lastErr string
	for time.Now().Before(deadline) {
		out, err := nsKubectl(ctx, kc, args...)
		if err == nil {
			cond, ok, perr := parseReadyCondition([]byte(out))
			if perr == nil {
				last = cond
				if isReady(cond, ok) {
					return cond
				}
				if ok && cond.Status == "False" {
					lastErr = cond.Reason + ": " + cond.Message
				}
			}
		} else {
			lastErr = err.Error()
		}
		select {
		case <-ctx.Done():
			t.Fatalf("xacct: context cancelled waiting for %s/%s to become Ready (last: %s)", kind, name, lastErr)
		case <-time.After(xacctPollInterval):
		}
	}
	dumpXacctDiagnostics(t, ctx, kc, kind, ns, name)
	t.Fatalf("xacct: %s/%s did not become Ready within %s (last condition: %+v, last error: %s)", kind, name, timeout, last, lastErr)
	return esCondition{}
}

// assertXacctScopeDenied is the negative control for #1306: the SAME cross-account read, requested
// from a namespace labelled alethia.io/placement=namespace, must never sync and must materialize no
// Secret. Without this, "the store works" and "the store is correctly scoped" are indistinguishable.
//
// The condition REASON is logged, never matched: ESO's wording for a store that refuses a
// namespace is version-specific, and asserting on it would make a chart bump look like a security
// regression. What is asserted is behavioural — not Ready, and no Secret.
func assertXacctScopeDenied(t *testing.T, ctx context.Context, kc string, c secretsXacctConfig) bool {
	t.Helper()
	applyKube(t, ctx, kc, buildDeniedNamespace(secretsXacctDeniedNS))
	t.Cleanup(func() {
		_, _ = nsKubectl(context.Background(), kc, "delete", "namespace", secretsXacctDeniedNS, "--wait=false", "--ignore-not-found")
	})
	applyKube(t, ctx, kc, buildScopeProbeExternalSecret(secretsXacctDeniedNS, secretsXacctProbeES, c.storeName(), c.remoteKey))

	deadline := time.Now().Add(xacctDeniedProbeWindow)
	for time.Now().Before(deadline) {
		out, err := nsKubectl(ctx, kc, "get", "externalsecret", secretsXacctProbeES, "-n", secretsXacctDeniedNS, "-o", "json")
		if err == nil {
			cond, ok, perr := parseReadyCondition([]byte(out))
			if perr == nil && isReady(cond, ok) {
				t.Fatalf("SCOPE LEAK: an ExternalSecret in a namespace labelled alethia.io/placement=namespace SYNCED against %s — a placed tenant can read the foreign account (#1306)", c.storeName())
			}
			if ok {
				t.Logf("xacct scope probe: not Ready, as required (reason=%s)", cond.Reason)
			}
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(xacctDeniedPollInterval):
		}
	}
	// The Secret must not exist either — a store that refused the ExternalSecret but left a Secret
	// behind would still have leaked the value.
	if _, err := nsKubectl(ctx, kc, "get", "secret", secretsXacctProbeES, "-n", secretsXacctDeniedNS); err == nil {
		t.Fatalf("SCOPE LEAK: a Secret materialized in the denied namespace from %s (#1306)", c.storeName())
	}
	t.Logf("xacct: the denied namespace never synced and materialized no Secret — the #1306 store scoping holds")
	return true
}

// applyKube applies an in-memory manifest via a temp file.
func applyKube(t *testing.T, ctx context.Context, kc, manifest string) {
	t.Helper()
	f, err := os.CreateTemp("", "xacct-*.yaml")
	if err != nil {
		t.Fatalf("temp manifest: %v", err)
	}
	defer os.Remove(f.Name())
	if _, err := f.WriteString(manifest); err != nil {
		f.Close()
		t.Fatalf("write manifest: %v", err)
	}
	f.Close()
	if out, err := nsKubectl(ctx, kc, "apply", "-f", f.Name()); err != nil {
		t.Fatalf("kubectl apply: %v\n%s", err, out)
	}
}

// nsKubectlOut runs kubectl and fails the test on error, returning stdout.
func nsKubectlOut(t *testing.T, ctx context.Context, kc string, args ...string) []byte {
	t.Helper()
	out, err := nsKubectl(ctx, kc, args...)
	if err != nil {
		t.Fatalf("kubectl %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return []byte(out)
}

// dumpXacctDiagnostics prints what an operator would look at first.
func dumpXacctDiagnostics(t *testing.T, ctx context.Context, kc, kind, ns, name string) {
	t.Helper()
	args := []string{"describe", kind, name}
	if ns != "" {
		args = append(args, "-n", ns)
	}
	if out, err := nsKubectl(ctx, kc, args...); err == nil {
		t.Logf("xacct: describe %s/%s:\n%s", kind, name, out)
	}
	if out, err := nsKubectl(ctx, kc, "logs", "-n", "external-secrets-operator",
		"-l", "app.kubernetes.io/name=external-secrets", "--tail=100"); err == nil {
		t.Logf("xacct: external-secrets operator logs (tail):\n%s", out)
	}
}

// writeXacctSummary folds the machine-readable verdict into the proof bundle. Best-effort: a
// summary-write failure must not mask the real assertion outcome.
func writeXacctSummary(t *testing.T, c secretsXacctConfig, s xacctSummary) {
	t.Helper()
	if c.summaryPath == "" {
		return
	}
	b, err := xacctSummaryJSON(s)
	if err != nil {
		t.Logf("xacct: could not render the summary: %v", err)
		return
	}
	if err := os.WriteFile(c.summaryPath, b, 0o644); err != nil {
		t.Logf("xacct: could not write the summary to %s: %v", c.summaryPath, err)
	}
}
