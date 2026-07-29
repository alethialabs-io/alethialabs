// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

//go:build e2e_t2

// Keyless database auth against a REAL cloud database (#1511) — the ORCHESTRATION half.
// Compiled only under e2e_t2; every deterministic helper it calls lives in the untagged
// t2_keyless_db.go so it stays unit-testable without a cloud.
package e2e

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/manifests"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

const (
	keylessWorkloadTimeout = 8 * time.Minute
	keylessPollInterval    = 10 * time.Second
	keylessProbeTimeout    = 3 * time.Minute
	// keylessDwellSlack bounds the held-open session: the dwell plus room for the final query. The
	// exec is NOT given the bare dwell — a client killed exactly at the deadline would be
	// indistinguishable from a session the proxy dropped, which is the outcome under test.
	keylessDwellSlack = 4 * time.Minute
)

// keylessDBParams is what the T2 driver hands this layer.
type keylessDBParams struct {
	cfg     keylessDBConfig
	dbName  string // the database name after applyToSnapshot's overlay
	metaRaw []byte // the base DEPLOY's execution_metadata
}

// runT2KeylessDB proves keyless database auth end to end, in the order that fails EARLIEST and most
// informatively:
//
//	(a) the deploy's own decision record says the binding was WIRED — catches a fail-closed render
//	    before any cluster polling, and reports the cell's own reason for the refusal;
//	(b) the bootstrap Job did not FAIL, and the workload-identity ServiceAccount exists carrying this
//	    cloud's identity annotation — the cluster-side identity object, and where a broken trust
//	    relationship is visible without waiting for a connection to time out;
//	(c) the PRODUCT-rendered workload is Available, carries the proxy sidecar, points at the loopback
//	    proxy, and holds NO password material — the positive shape of keyless, on the object the
//	    cluster actually has;
//	(d) a password-free query succeeds and returns OUR value (sha256-compared) — the claim itself;
//	(e) the session survives past the cloud token's lifetime, and a NEW connection then succeeds —
//	    mint-per-connection, which is the entire reason db-authproxy exists;
//	(f) the NEGATIVE control: the same connect attempted from an UNSCOPED identity must fail, or (d)
//	    proves only that a database was reachable.
//
// Why there is no "the bootstrap Job reached Complete" assertion: the Job is an ArgoCD PreSync hook
// carrying hook-delete-policy HookSucceeded, so on success it is DELETED before the deploy job even
// reports SUCCESS. Polling for a Complete Job would therefore never see one, and a test that treats
// "absent" as "passed" asserts nothing. A FAILED hook is not reaped, so its absence-or-not-failed is
// the honest observable — and its real outcome is proven downstream: without the login its SQL
// creates, the query in (d) cannot connect at all.
func runT2KeylessDB(t *testing.T, ctx context.Context, kc string, p keylessDBParams) {
	t.Helper()
	summary := keylessSummary{
		Provider:     p.cfg.provider,
		Engine:       p.cfg.engine,
		Database:     p.dbName,
		Service:      p.cfg.serviceName,
		DwellSeconds: int(p.cfg.dwell / time.Second),
		Verdict:      "FAIL",
	}
	defer func() { writeKeylessSummary(t, p.cfg, summary) }()

	// (a) The runner's own decision record.
	rec, found, err := keylessDecisionFor(p.metaRaw, p.cfg.serviceName, p.dbName)
	if err != nil {
		t.Fatalf("keyless: %v", err)
	}
	switch {
	case !found:
		t.Fatalf("no keyless decision for %s→database/%s in execution_metadata. The render never "+
			"CONSIDERED the binding — the dark flag was off, the service was skipped as unbuilt, or the "+
			"apps repo was not wired. That is a different failure from a refusal, and it means nothing "+
			"downstream of here would be testing keyless at all", p.cfg.serviceName, p.dbName)
	case rec.Status == "failed_closed":
		t.Fatalf("the deploy REFUSED the keyless binding for %s × %s: %s", p.cfg.provider, p.cfg.engine, rec.Reason)
	case rec.Status != "wired":
		t.Fatalf("unexpected keyless decision status %q (%s)", rec.Status, rec.Reason)
	}
	if rec.Engine != p.cfg.engine {
		t.Fatalf("the deploy wired the %s cell but this scenario configured %s — the run would prove the wrong cell", rec.Engine, p.cfg.engine)
	}
	summary.DecisionWired = true
	summary.Mechanism = rec.Reason
	t.Logf("keyless: the deploy recorded the binding WIRED — %s", rec.Reason)

	// (b) The bootstrap hook and the cluster-side identity.
	assertBootstrapDidNotFail(t, ctx, kc, p)
	summary.BootstrapRan = true
	assertKeylessServiceAccount(t, ctx, kc, p)

	// (c) The product-rendered workload.
	deploy := awaitKeylessWorkload(t, ctx, kc, p)
	summary.WorkloadReady = true
	tmpl, err := parsePodTemplate(deploy)
	if err != nil {
		t.Fatalf("keyless: %v", err)
	}
	proxyName := p.cfg.keylessProxyContainer()
	proxy, ok := tmpl.container(proxyName)
	if !ok {
		t.Fatalf("the rendered pod has no %q container — the workload was deployed with no proxy to connect through", proxyName)
	}
	if problems := tmpl.assertNoPasswordMaterial(); len(problems) > 0 {
		t.Fatalf("the workload holds password material, so it is not keyless:\n  %s", strings.Join(problems, "\n  "))
	}
	if host, ok := tmpl.appEndpointEnv(p.cfg.serviceName); !ok || host != authProxyLoopback {
		t.Fatalf("the app's DATABASE_HOST is %q (found=%v), want the loopback proxy %q — a workload pointed straight at the cloud database is authenticating with something", host, ok, authProxyLoopback)
	}
	summary.NoPasswordSeen = true
	t.Logf("keyless: %s is Available with the %s sidecar, a loopback endpoint and no Secret reference anywhere in its pod", p.cfg.serviceName, proxyName)

	// (d) The password-free query.
	canary := keylessCanary(t)
	want := sha256.Sum256([]byte(canary))
	pod := keylessPodName(t, ctx, kc, p)
	got := keylessQuery(t, ctx, kc, p, pod, canary, keylessProbeTimeout)
	if !strings.EqualFold(got, hex.EncodeToString(want[:])) {
		t.Fatalf("keyless query returned a value whose sha256 is %s, want %s — the session connected but did not read back what we wrote", got, hex.EncodeToString(want[:]))
	}
	summary.QueryPassed = true
	t.Logf("keyless: a query succeeded through the product's proxy with NO password anywhere — %s × %s authenticated with the pod's own cloud identity", p.cfg.provider, p.cfg.engine)

	// (e) Rotation. This is the assertion the whole db-authproxy design rests on.
	assertKeylessSurvivesRotation(t, ctx, kc, p, pod, &summary)

	// (f) The negative control.
	summary.ScopeDenied = assertUnscopedIdentityDenied(t, ctx, kc, p, proxy)

	summary.Verdict = "PASS"
}

// authProxyLoopback is the address the product rewrites a keyless endpoint to. A constant mirror of
// manifests' authProxyListenHost (unexported): db-authproxy REFUSES a non-loopback listener, so this
// is a literal on both sides rather than a knob.
const authProxyLoopback = "127.0.0.1"

// assertBootstrapDidNotFail checks the one bootstrap-hook state that is actually observable after
// convergence. HookSucceeded deletes the Job on success, so its ABSENCE is the normal case and is
// not evidence of anything; its PRESENCE in a Failed state, on the other hand, is where a cloud trust
// error speaks in full — an IAM policy that does not cover the login, an Entra admin never set.
func assertBootstrapDidNotFail(t *testing.T, ctx context.Context, kc string, p keylessDBParams) {
	t.Helper()
	job := manifests.BootstrapJobName(types.ServiceBindingTarget{
		Kind: types.ServiceBindingKindDatabase,
		Name: p.dbName,
	})
	out, err := nsKubectl(ctx, kc, "get", "job", job, "-n", p.cfg.namespace, "-o", "json")
	if err != nil {
		t.Logf("keyless: no bootstrap Job %s/%s present — expected, the PreSync hook is reaped on success (hook-delete-policy: HookSucceeded)", p.cfg.namespace, job)
		return
	}
	outcome, perr := parseJobOutcome([]byte(out))
	if perr != nil {
		t.Fatalf("keyless: %v", perr)
	}
	if outcome.Failed {
		if logs, lerr := nsKubectl(ctx, kc, "logs", "-n", p.cfg.namespace, "job/"+job, "--tail=200"); lerr == nil {
			t.Logf("keyless: bootstrap Job logs:\n%s", logs)
		}
		t.Fatalf("the keyless bootstrap Job %s FAILED (%s) — the app's database login was never created, so nothing downstream could authenticate", job, outcome.Detail)
	}
	t.Logf("keyless: bootstrap Job %s is present and not failed (%s)", job, outcome.Detail)
}

// assertKeylessServiceAccount checks the cluster-side identity object: the ServiceAccount the pod
// runs as must exist AND carry this cloud's identity annotation. An unannotated (or missing) KSA is
// the single most common way federation silently does not happen — the pod schedules, the proxy
// starts, and every connection is refused with a message about credentials rather than about trust.
func assertKeylessServiceAccount(t *testing.T, ctx context.Context, kc string, p keylessDBParams) {
	t.Helper()
	want := keylessIdentityAnnotation(p.cfg.provider)
	out, err := nsKubectl(ctx, kc, "get", "serviceaccount", keylessKSA, "-n", p.cfg.namespace,
		"-o", "jsonpath={.metadata.annotations."+strings.ReplaceAll(want, ".", `\.`)+"}")
	if err != nil {
		t.Fatalf("the workload-identity ServiceAccount %s/%s does not exist — the product emits it with the keyless binding, so the pod has no identity to federate: %v", p.cfg.namespace, keylessKSA, err)
	}
	if strings.TrimSpace(out) == "" {
		t.Fatalf("ServiceAccount %s/%s carries no %s annotation — the pod runs as an identity the cloud will not federate", p.cfg.namespace, keylessKSA, want)
	}
	t.Logf("keyless: ServiceAccount %s/%s carries %s (the cluster-side identity object)", p.cfg.namespace, keylessKSA, want)
}

// keylessKSA is the workload-identity ServiceAccount name — a constant mirror of manifests'
// keylessKSAName, which the per-cloud templates pin their federation subject to.
const keylessKSA = "alethia-app"

// keylessSelector is the label the generated Deployment selects its pods on. It is
// `app.kubernetes.io/name`, NOT `app`: a wrong selector here matches nothing, and "no Running pod"
// would be reported as a keyless failure when the workload was healthy all along.
const keylessSelector = "app.kubernetes.io/name"

// keylessIdentityAnnotation is the annotation each cloud's identity webhook/controller keys on.
func keylessIdentityAnnotation(provider string) string {
	switch provider {
	case "gcp":
		return "iam.gke.io/gcp-service-account"
	case "azure":
		return "azure.workload.identity/client-id"
	default:
		return "eks.amazonaws.com/role-arn"
	}
}

// awaitKeylessWorkload polls the product-rendered Deployment until Available, returning its JSON.
func awaitKeylessWorkload(t *testing.T, ctx context.Context, kc string, p keylessDBParams) []byte {
	t.Helper()
	deadline := time.Now().Add(keylessWorkloadTimeout)
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
		select {
		case <-ctx.Done():
			t.Fatalf("keyless: context cancelled waiting for deployment/%s (last: %+v)", p.cfg.serviceName, last)
		case <-time.After(keylessPollInterval):
		}
	}
	dumpKeylessDiagnostics(t, ctx, kc, p)
	t.Fatalf("keyless: deployment/%s never became Available within %s (last condition: %+v)", p.cfg.serviceName, keylessWorkloadTimeout, last)
	return nil
}

// keylessPodName resolves one Running pod of the workload — the pod the ephemeral client joins.
func keylessPodName(t *testing.T, ctx context.Context, kc string, p keylessDBParams) string {
	t.Helper()
	out, err := nsKubectl(ctx, kc, "get", "pods", "-n", p.cfg.namespace,
		"-l", keylessSelector+"="+p.cfg.serviceName, "--field-selector=status.phase=Running",
		"-o", "jsonpath={.items[0].metadata.name}")
	name := strings.TrimSpace(out)
	if err != nil || name == "" {
		t.Fatalf("keyless: no Running pod for %s: %v (%s)", p.cfg.serviceName, err, out)
	}
	return name
}

// keylessCanary is the value written and read back. Generated per run, never logged: it is compared
// as a digest so that even a failure message cannot echo it.
func keylessCanary(t *testing.T) string {
	t.Helper()
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		t.Fatalf("keyless: generate canary: %v", err)
	}
	return hex.EncodeToString(b)
}

// keylessQuery runs the probe SQL from an EPHEMERAL container injected into the product-rendered pod,
// and returns the sha256 of the value it read back.
//
// An ephemeral container shares the target pod's network namespace, so 127.0.0.1:<port> is the
// PRODUCT's own proxy — not one the test started. Only the client binary is injected. The
// alternatives are all worse: a hand-authored probe pod running its own db-authproxy would prove the
// proxy works rather than that Alethia wires it, and a port-forward would move the connection off
// the pod's identity entirely.
func keylessQuery(t *testing.T, ctx context.Context, kc string, p keylessDBParams, pod, canary string, timeout time.Duration) string {
	t.Helper()
	sql := keylessProbeSQL(p.cfg.engine, keylessCanaryTable, canary)
	argv := keylessClientArgv(p.cfg.engine, manifests.KeylessDBUser, p.dbName, keylessEnginePort(p.cfg.engine), sql)
	out, err := keylessDebugExec(ctx, kc, p, pod, "probe", argv, timeout)
	if err != nil {
		t.Fatalf("keyless: the password-free query FAILED — %v\n%s", err, out)
	}
	value, perr := parseProbeValue(out)
	if perr != nil {
		t.Fatalf("keyless: %v\n%s", perr, out)
	}
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

// keylessCanaryTable is the scratch table the probe writes. Named for what it is so an operator
// finding it in a real database knows where it came from.
const keylessCanaryTable = "alethia_e2e_keyless_canary"

// keylessDebugExec runs argv in an ephemeral container attached to pod. Each call needs a distinct
// container name — a pod's ephemeralContainers list is append-only and a repeated name is rejected.
func keylessDebugExec(ctx context.Context, kc string, p keylessDBParams, pod, tag string, argv []string, timeout time.Duration) (string, error) {
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	args := []string{
		"--kubeconfig", kc, "debug", "pod/" + pod, "-n", p.cfg.namespace,
		"--image=" + p.cfg.clientImage,
		"--container=keyless-" + tag,
		"--quiet", "--attach", "--stdin=false", "--tty=false",
		"--",
	}
	args = append(args, argv...)
	out, err := exec.CommandContext(cctx, "kubectl", args...).CombinedOutput()
	return string(out), err
}

// assertKeylessSurvivesRotation is the assertion db-authproxy exists for.
//
// Two claims, and they fail differently. First, a session opened BEFORE the cloud token's lifetime
// elapsed must still work after it: the token was consumed at connect time and the connection is a
// spliced wire, so nothing about it should expire. Second, a session opened AFTER must also work,
// which is what proves the proxy MINTS per connection rather than caching the one token it got at
// startup — a proxy that cached would pass the first check and fail only here.
//
// The dwell is not a tuning knob to shorten thoughtfully: below the token TTL both checks pass
// against a proxy that never rotates anything, and the run would claim a proof it did not perform.
func assertKeylessSurvivesRotation(t *testing.T, ctx context.Context, kc string, p keylessDBParams, pod string, summary *keylessSummary) {
	t.Helper()
	t.Logf("keyless: holding a session open for %s — past the cloud token's lifetime — then querying it again", p.cfg.dwell)
	held := keylessHoldSQL(p.cfg.engine, p.cfg.dwell, keylessCanaryTable)
	argv := keylessClientArgv(p.cfg.engine, manifests.KeylessDBUser, p.dbName, keylessEnginePort(p.cfg.engine), held)
	out, err := keylessDebugExec(ctx, kc, p, pod, "dwell", argv, p.cfg.dwell+keylessDwellSlack)
	if err != nil {
		t.Fatalf("keyless: a session held open for %s did NOT survive — the connection died with the credential it never had:\n%v\n%s", p.cfg.dwell, err, out)
	}
	if _, perr := parseProbeValue(out); perr != nil {
		t.Fatalf("keyless: the held session returned no row after %s — %v\n%s", p.cfg.dwell, perr, out)
	}
	summary.SurvivedDwell = true
	t.Logf("keyless: the session survived %s and still answered — nothing about a spliced connection expires with the token that opened it", p.cfg.dwell)

	// A FRESH connection, now that the original mint is certainly stale.
	canary := keylessCanary(t)
	want := sha256.Sum256([]byte(canary))
	got := keylessQuery(t, ctx, kc, p, pod, canary, keylessProbeTimeout)
	if !strings.EqualFold(got, hex.EncodeToString(want[:])) {
		t.Fatalf("keyless: a NEW connection after the dwell read back the wrong value (sha256 %s, want %s)", got, hex.EncodeToString(want[:]))
	}
	summary.FreshMintOK = true
	t.Logf("keyless: a NEW connection after %s authenticated too — the proxy mints per connection rather than holding one token", p.cfg.dwell)
}

// keylessHoldSQL opens a session, sleeps past the token lifetime IN the database, then reads back —
// all on ONE connection. The sleep is server-side deliberately: a client-side sleep between two
// invocations would open two connections and prove nothing about the first one surviving.
func keylessHoldSQL(engine string, dwell time.Duration, table string) string {
	seconds := int(dwell / time.Second)
	if engine == keylessEngineMySQL {
		return fmt.Sprintf("SELECT SLEEP(%d); SELECT v FROM %s WHERE k = 'canary';", seconds, table)
	}
	return fmt.Sprintf("SELECT pg_sleep(%d); SELECT v FROM %s WHERE k = 'canary';", seconds, table)
}

// assertUnscopedIdentityDenied is the NEGATIVE control. Without it, (d) proves only that a database
// is reachable from this cluster — not that reaching it required the identity the platform granted.
//
// The probe runs the PRODUCT's own proxy container verbatim (same image, same args, same loopback
// address) in a pod on the namespace's default ServiceAccount. Exactly one variable changes: the
// identity. It must not connect.
//
// The cloud's error wording is logged, never matched — it is provider- and version-specific, and
// asserting on it would make a message change look like a security regression.
func assertUnscopedIdentityDenied(t *testing.T, ctx context.Context, kc string, p keylessDBParams, proxy podContainer) bool {
	t.Helper()
	pod := "keyless-unscoped-probe"
	applyKube(t, ctx, kc, buildUnscopedProxyProbePod(pod, p.cfg.namespace, p.cfg.clientImage, proxy))
	t.Cleanup(func() {
		_, _ = nsKubectl(context.Background(), kc, "delete", "pod", pod, "-n", p.cfg.namespace, "--wait=false", "--ignore-not-found")
	})
	// Deliberately NOT --for=condition=Ready: the proxy container may crash-loop precisely BECAUSE it
	// has no identity to mint from, and that is a pass, not a setup failure. All the client container
	// needs is to be running.
	if _, err := nsKubectl(ctx, kc, "wait", "--for=jsonpath={.status.phase}=Running", "pod/"+pod,
		"-n", p.cfg.namespace, "--timeout=120s"); err != nil {
		t.Logf("keyless: the unscoped probe pod is not Running (%v) — attempting the connect anyway; a pod that cannot even start is not evidence either way", err)
	}
	sql := fmt.Sprintf("SELECT v FROM %s WHERE k = 'canary';", keylessCanaryTable)
	argv := keylessClientArgv(p.cfg.engine, manifests.KeylessDBUser, p.dbName, keylessEnginePort(p.cfg.engine), sql)
	full := append([]string{"exec", pod, "-n", p.cfg.namespace, "-c", "client", "--"}, argv...)
	out, err := nsKubectl(ctx, kc, full...)
	if err == nil {
		if _, perr := parseProbeValue(out); perr == nil {
			t.Fatalf("SCOPE LEAK: a pod on the default ServiceAccount — no workload identity, nothing for the cloud to federate — ran the product's own proxy and READ the canary:\n%s", out)
		}
	}
	t.Logf("keyless: the unscoped identity was refused, as required (client error logged, not matched):\n%s", strings.TrimSpace(out))
	return true
}

// dumpKeylessDiagnostics prints what an operator would look at first.
func dumpKeylessDiagnostics(t *testing.T, ctx context.Context, kc string, p keylessDBParams) {
	t.Helper()
	if out, err := nsKubectl(ctx, kc, "describe", "deployment", p.cfg.serviceName, "-n", p.cfg.namespace); err == nil {
		t.Logf("keyless: describe deployment/%s:\n%s", p.cfg.serviceName, out)
	}
	if out, err := nsKubectl(ctx, kc, "logs", "-n", p.cfg.namespace,
		"-l", keylessSelector+"="+p.cfg.serviceName, "-c", p.cfg.keylessProxyContainer(), "--tail=100"); err == nil {
		t.Logf("keyless: %s logs (tail):\n%s", p.cfg.keylessProxyContainer(), out)
	}
}

// writeKeylessSummary folds the machine-readable verdict into the proof bundle. Best-effort: a
// summary-write failure must not mask the real assertion outcome.
func writeKeylessSummary(t *testing.T, c keylessDBConfig, s keylessSummary) {
	t.Helper()
	if c.summaryPath == "" {
		return
	}
	b, err := keylessSummaryJSON(s)
	if err != nil {
		t.Logf("keyless: could not render the summary: %v", err)
		return
	}
	if err := os.WriteFile(c.summaryPath, b, 0o644); err != nil {
		t.Logf("keyless: could not write the summary to %s: %v", c.summaryPath, err)
	}
}
