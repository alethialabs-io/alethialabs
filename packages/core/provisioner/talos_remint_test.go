// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math/big"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// #5330: a dedicated hetzner cluster's `kubeconfig` output is ONE admin certificate from the last
// apply. These tests hand every path a state whose stored certificate has EXPIRED, next to a
// talosconfig, and a fake apiserver (a kubectl stub) that answers 401 to the expired certificate the
// way kube-apiserver does. Each path must still work, which it can only do by minting.

const testTalosEndpoint = "https://203.0.113.10:6443"

// testAdminKubeconfig renders a kubeconfig for testTalosEndpoint whose client certificate is a real
// x509 certificate valid until notAfter, so "expired" in these tests is a property of the certificate
// rather than of a label.
func testAdminKubeconfig(t *testing.T, cn string, notAfter time.Time) (kubeconfig, certB64 string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: cn, Organization: []string{"system:masters"}},
		NotBefore:    notAfter.Add(-time.Hour),
		NotAfter:     notAfter,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	certB64 = base64.StdEncoding.EncodeToString(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
	kubeconfig = fmt.Sprintf(`apiVersion: v1
kind: Config
clusters:
- name: talos
  cluster:
    server: %s
contexts:
- name: admin@talos
  context: {cluster: talos, user: admin@talos}
current-context: admin@talos
users:
- name: admin@talos
  user:
    client-certificate-data: %s
`, testTalosEndpoint, certB64)
	return kubeconfig, certB64
}

// fakeAPIServer is a kubectl stub standing in for a cluster whose apiserver rejects one certificate
// (the expired stored one) with 401 and accepts any other, and refuses a call with no kubeconfig in
// place. Every call is logged as "401 <args>", "none <args>" or "ok <args>", so a test can assert the
// expired certificate was never even presented.
type fakeAPIServer struct{ dir string }

func stubFakeAPIServer(t *testing.T, expiredCertB64 string) *fakeAPIServer {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the stub kubectl is a shell script")
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "expired"), []byte(expiredCertB64), 0o600); err != nil {
		t.Fatal(err)
	}
	script := "#!/bin/sh\n" +
		// No kubeconfig in place is what real kubectl answers with a refused localhost:8080 dial.
		"if [ -z \"$KUBECONFIG\" ] || [ ! -f \"$KUBECONFIG\" ]; then\n" +
		"  printf 'none %s\\n' \"$*\" >> " + dir + "/calls\n" +
		"  echo 'The connection to the server localhost:8080 was refused' >&2; exit 1\n" +
		"fi\n" +
		"if grep -qF \"$(cat " + dir + "/expired)\" \"$KUBECONFIG\"; then\n" +
		"  printf '401 %s\\n' \"$*\" >> " + dir + "/calls\n" +
		"  echo 'error: You must be logged in to the server (Unauthorized)' >&2; exit 1\n" +
		"fi\n" +
		"printf 'ok %s\\n' \"$*\" >> " + dir + "/calls\n" +
		"case \"$*\" in\n" +
		"  *--raw=/readyz*) printf 'ok'; exit 0;;\n" +
		"  *'--raw /version'*) printf '{\"gitVersion\":\"v1.33.0\"}'; exit 0;;\n" +
		"  *'config view'*) printf '" + testTalosEndpoint + "'; exit 0;;\n" +
		"  *'get services'*|*'get ingresses'*) printf '{\"items\":[]}'; exit 0;;\n" +
		"  *'version -o json'*) printf '{\"serverVersion\":{\"gitVersion\":\"v1.33.0\"}}'; exit 0;;\n" +
		"  *'get nodes -o json'*) printf '{\"items\":[{\"status\":{\"conditions\":[{\"type\":\"Ready\",\"status\":\"True\"}]}}]}'; exit 0;;\n" +
		"  *' -o json'*) printf '{\"items\":[]}'; exit 0;;\n" +
		"esac\nexit 0\n"
	if err := os.WriteFile(filepath.Join(dir, "kubectl"), []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return &fakeAPIServer{dir: dir}
}

// calls returns every kubectl invocation the fake apiserver saw, each prefixed with its answer.
func (f *fakeAPIServer) calls(t *testing.T) []string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(f.dir, "calls"))
	if err != nil {
		return nil
	}
	return strings.Split(strings.TrimRight(string(b), "\n"), "\n")
}

// assertNeverPresentedExpired fails when any call reached the apiserver with the expired certificate,
// and when no call reached it at all (a path that skipped the cluster passes the first check vacuously).
func (f *fakeAPIServer) assertNeverPresentedExpired(t *testing.T) {
	t.Helper()
	calls := f.calls(t)
	answered := false
	for _, c := range calls {
		if strings.HasPrefix(c, "401 ") {
			t.Fatalf("the expired stored certificate was presented to the apiserver:\n%s", strings.Join(calls, "\n"))
		}
		answered = answered || strings.HasPrefix(c, "ok ")
	}
	if !answered {
		t.Fatalf("no kubectl call was answered by the cluster — the path skipped it, which is the #5330 symptom:\n%s",
			strings.Join(calls, "\n"))
	}
}

// expiredHetznerState is a hetzner state as the last apply left it a day ago: the stored kubeconfig's
// certificate has expired; the talosconfig beside it is what can mint a new one.
type expiredHetznerState struct {
	outputs     map[string]interface{}
	expiredCert string
	fresh       string
	mints       int
}

func newExpiredHetznerState(t *testing.T) *expiredHetznerState {
	t.Helper()
	stored, expiredCert := testAdminKubeconfig(t, "admin-from-last-apply", time.Now().Add(-23*time.Hour))
	fresh, _ := testAdminKubeconfig(t, "admin-minted-now", time.Now().Add(time.Hour))
	return &expiredHetznerState{
		outputs: map[string]interface{}{
			"talos_cluster_name":     "shop-prod",
			"talos_cluster_endpoint": testTalosEndpoint,
			"kubeconfig":             stored,
			"talosconfig":            "context: shop-prod\ncontexts:\n  shop-prod:\n    endpoints: [203.0.113.10]\n",
		},
		expiredCert: expiredCert,
		fresh:       fresh,
	}
}

// minter is the fake TalosconfigMinter: it checks it was handed the state's talosconfig and returns
// a kubeconfig whose certificate is valid for the next hour.
func (s *expiredHetznerState) minter(t *testing.T) TalosconfigMinter {
	return func(_ context.Context, talosconfig string) (string, error) {
		if talosconfig != s.outputs["talosconfig"] {
			t.Errorf("the minter was not handed the state's talosconfig: %q", talosconfig)
		}
		s.mints++
		return s.fresh, nil
	}
}

// isolateKubeconfig gives the test a private HOME, where hetznerProvider.ConfigureKubeconfig writes,
// and restores KUBECONFIG, which it sets process-wide.
func isolateKubeconfig(t *testing.T) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("KUBECONFIG", "")
}

func hetznerTestProvider(t *testing.T) cloud.CloudProvider {
	t.Helper()
	p, err := cloud.NewCloudProvider("hetzner")
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func hetznerTestConfig() *types.ProjectConfig {
	vc := &types.ProjectConfig{ProjectName: "shop", EnvironmentStage: "prod"}
	vc.Cluster.ClusterName = "shop-prod"
	return vc
}

// PROBE_CLUSTER, a day after the deploy: the cluster is healthy and must be reported reachable.
// Before #5330 the probe presented the stored certificate, got a 401 and fired the outage alert.
func TestProbeWithAnExpiredStoredCertMintsAndStaysReachable(t *testing.T) {
	isolateKubeconfig(t)
	st := newExpiredHetznerState(t)
	api := stubFakeAPIServer(t, st.expiredCert)

	res := probeFromOutputs(context.Background(), ProbeParams{
		ProjectConfig: hetznerTestConfig(), Provider: "hetzner", TalosMint: st.minter(t),
	}, hetznerTestProvider(t), st.outputs, 10*time.Second, io.Discard, io.Discard)

	if !res.Reachable {
		t.Fatalf("a healthy cluster was reported unreachable a day after its deploy: %+v", res)
	}
	if st.mints != 1 {
		t.Errorf("the probe minted %d kubeconfig(s), want exactly 1", st.mints)
	}
	api.assertNeverPresentedExpired(t)
}

// With a talosconfig in the state and no minter wired, the probe must NOT fall back to the stored
// certificate: the honest answer is an unreachable result that names the wiring fault.
func TestProbeWithoutAMinterDoesNotFallBackToTheStoredCert(t *testing.T) {
	isolateKubeconfig(t)
	st := newExpiredHetznerState(t)
	api := stubFakeAPIServer(t, st.expiredCert)

	res := probeFromOutputs(context.Background(), ProbeParams{
		ProjectConfig: hetznerTestConfig(), Provider: "hetzner",
	}, hetznerTestProvider(t), st.outputs, 10*time.Second, io.Discard, io.Discard)

	if res.Reachable {
		t.Fatal("no minter, yet the probe reported reachable")
	}
	if !strings.Contains(res.Detail.Error, "minter") {
		t.Errorf("the reason does not name the missing minter: %q", res.Detail.Error)
	}
	if calls := api.calls(t); len(calls) != 0 {
		t.Errorf("the probe dialled the cluster with no minted credential:\n%s", strings.Join(calls, "\n"))
	}
}

// Drift's InspectCluster, a day after the deploy: add-on health and posture must be read through a
// minted credential. Before #5330 every read 401'd and the best-effort readers swallowed it.
func TestInspectClusterWithAnExpiredStoredCertMints(t *testing.T) {
	isolateKubeconfig(t)
	st := newExpiredHetznerState(t)
	api := stubFakeAPIServer(t, st.expiredCert)
	vc := hetznerTestConfig()
	vc.AddOns = []types.AddOnInstall{{ID: "loki", Mode: "managed"}}

	_, sec, _ := InspectCluster(context.Background(), vc, "hetzner", st.outputs, st.minter(t), io.Discard, io.Discard)
	if sec == nil {
		t.Fatal("inspection was skipped")
	}
	if st.mints != 1 {
		t.Errorf("inspection minted %d kubeconfig(s), want exactly 1", st.mints)
	}
	api.assertNeverPresentedExpired(t)
}

// A failed mint skips the inspection; it does not quietly inspect with the expired certificate.
func TestInspectClusterDoesNotFallBackWhenTheMintFails(t *testing.T) {
	isolateKubeconfig(t)
	st := newExpiredHetznerState(t)
	api := stubFakeAPIServer(t, st.expiredCert)
	failing := func(context.Context, string) (string, error) { return "", errors.New("apid unreachable") }

	addon, sec, gitops := InspectCluster(context.Background(), hetznerTestConfig(), "hetzner", st.outputs, failing, io.Discard, io.Discard)
	if addon != nil || sec != nil || gitops != nil {
		t.Errorf("a failed mint should skip the inspection, got (%v, %v, %v)", addon, sec, gitops)
	}
	if calls := api.calls(t); len(calls) != 0 {
		t.Errorf("inspection reached the cluster without a minted credential:\n%s", strings.Join(calls, "\n"))
	}
}

// The destroy's load-balancer release, a day after the deploy: it must reach the cluster and release.
// Before #5330 it skipped with "may still bill" and hcloud CCM load balancers outlived the teardown.
func TestReleaseWithAnExpiredStoredCertMintsAndReleases(t *testing.T) {
	isolateKubeconfig(t)
	shortWaits(t)
	st := newExpiredHetznerState(t)
	api := stubFakeAPIServer(t, st.expiredCert)
	var out bytes.Buffer

	rel := releaseLoadBalancersWithOutputs(context.Background(), hetznerTestProvider(t), hetznerTestConfig(),
		"hetzner", st.minter(t), st.outputs, &out)

	if !rel.Clean || rel.Skipped != "" || rel.MintFailed != "" {
		t.Fatalf("the release did not run to a clean finish: %+v\n%s", rel, out.String())
	}
	if st.mints != 1 {
		t.Errorf("the release minted %d kubeconfig(s), want exactly 1", st.mints)
	}
	api.assertNeverPresentedExpired(t)
	if destroyOutcomeError(rel, nil) != nil {
		t.Error("a clean release under a successful destroy was reported as a failure")
	}
}

// A failed mint must never become a quiet skip: the outcome carries MintFailed, and a destroy that
// otherwise SUCCEEDED is then a failed job naming the load balancers that may still bill.
func TestReleaseMintFailureFailsTheDestroyLoudly(t *testing.T) {
	isolateKubeconfig(t)
	shortWaits(t)
	st := newExpiredHetznerState(t)
	api := stubFakeAPIServer(t, st.expiredCert)
	failing := func(context.Context, string) (string, error) {
		return "", errors.New("talos endpoint unreachable")
	}
	var out bytes.Buffer

	rel := releaseLoadBalancersWithOutputs(context.Background(), hetznerTestProvider(t), hetznerTestConfig(),
		"hetzner", failing, st.outputs, &out)

	if rel.MintFailed == "" || rel.Skipped == "" || rel.NoCluster {
		t.Fatalf("a failed mint must be MintFailed + Skipped and retryable: %+v", rel)
	}
	if !strings.Contains(out.String(), "ERROR") {
		t.Errorf("the release log does not say it failed:\n%s", out.String())
	}
	if calls := api.calls(t); len(calls) != 0 {
		t.Errorf("the release fell back to the stored certificate:\n%s", strings.Join(calls, "\n"))
	}
	if !shouldRetryRelease(errors.New("network still in use"), rel, nil) {
		t.Error("a failed destroy after a failed mint must retry the release")
	}
	err := destroyOutcomeError(rel, nil)
	if err == nil {
		t.Fatal("a destroy whose load-balancer release could not mint a credential reported success")
	}
	for _, want := range []string{"talos endpoint unreachable", "MAY STILL EXIST AND STILL BILL"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the destroy error does not say %q:\n%v", want, err)
		}
	}
}

// The deploy's post-apply stages: the first configure and every refresh mint anew, and the stored
// certificate is never written to KUBECONFIG.
func TestDeployRefresherMintsBeforeEveryStep(t *testing.T) {
	isolateKubeconfig(t)
	st := newExpiredHetznerState(t)
	api := stubFakeAPIServer(t, st.expiredCert)
	var log bytes.Buffer
	r := newDeployKubeRefresher(hetznerTestProvider(t), hetznerTestConfig(), "hetzner", st.minter(t), st.outputs, &log)

	if err := r.configure(context.Background()); err != nil {
		t.Fatalf("configure: %v", err)
	}
	for _, step := range []string{"the ArgoCD install", "the add-on stage"} {
		if err := r.refresh(context.Background(), step); err != nil {
			t.Fatalf("refresh before %s: %v", step, err)
		}
		if _, err := runKubectlBounded(context.Background(), 5*time.Second, "get", "--raw=/readyz"); err != nil {
			t.Fatalf("the cluster rejected the kubeconfig in place before %s: %v", step, err)
		}
	}
	if st.mints != 3 {
		t.Errorf("minted %d time(s), want 3 (configure + two refreshes)", st.mints)
	}
	api.assertNeverPresentedExpired(t)
	if !strings.Contains(log.String(), "Re-minted the Talos admin kubeconfig before the add-on stage") {
		t.Errorf("the refresh does not say which step it re-minted for:\n%s", log.String())
	}
}

// A state with no talosconfig (any other cloud, or the e2e kind module driven as hetzner) keeps the
// provider's kubeconfig and refresh is a no-op: nothing is minted, nothing breaks.
func TestDeployRefresherIsANoOpWithoutATalosconfig(t *testing.T) {
	isolateKubeconfig(t)
	stored, _ := testAdminKubeconfig(t, "kind", time.Now().Add(time.Hour))
	calls := 0
	mint := func(context.Context, string) (string, error) { calls++; return "", errors.New("must not be called") }
	r := newDeployKubeRefresher(hetznerTestProvider(t), hetznerTestConfig(), "hetzner", mint,
		map[string]interface{}{"talos_cluster_name": "kind", "kubeconfig": stored}, io.Discard)

	if err := r.configure(context.Background()); err != nil {
		t.Fatalf("configure: %v", err)
	}
	if err := r.refresh(context.Background(), "the ArgoCD install"); err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if calls != 0 {
		t.Errorf("the minter was called %d time(s) for a state with no talosconfig", calls)
	}
	b, err := os.ReadFile(os.Getenv("KUBECONFIG"))
	if err != nil || string(b) != stored {
		t.Errorf("the provider's kubeconfig was not the one in place (err %v)", err)
	}
}

// A mid-deploy re-mint retries a blip, fails the step on an outage, and never retries a missing
// minter — that is wiring, not weather.
func TestDeployRefresherRetriesThenFails(t *testing.T) {
	isolateKubeconfig(t)
	st := newExpiredHetznerState(t)
	var failuresLeft int
	mint := func(ctx context.Context, tc string) (string, error) {
		if failuresLeft > 0 {
			failuresLeft--
			return "", errors.New("apid: connection reset")
		}
		return st.fresh, nil
	}
	r := newDeployKubeRefresher(hetznerTestProvider(t), hetznerTestConfig(), "hetzner", mint, st.outputs, io.Discard)
	slept := 0
	r.sleep = func(time.Duration) { slept++ }

	if err := r.configure(context.Background()); err != nil {
		t.Fatalf("configure: %v", err)
	}
	failuresLeft = deployMintAttempts - 1
	if err := r.refresh(context.Background(), "the ArgoCD install"); err != nil {
		t.Fatalf("a blip shorter than the retry budget failed the deploy: %v", err)
	}
	failuresLeft = deployMintAttempts
	err := r.refresh(context.Background(), "the add-on stage")
	if err == nil || !strings.Contains(err.Error(), "the add-on stage") {
		t.Fatalf("an outage must fail the step and name it, got %v", err)
	}
	if slept != 2*(deployMintAttempts-1) {
		t.Errorf("slept %d time(s) between attempts, want %d", slept, 2*(deployMintAttempts-1))
	}

	noMinter := newDeployKubeRefresher(hetznerTestProvider(t), hetznerTestConfig(), "hetzner", nil, st.outputs, io.Discard)
	noMinter.sleep = func(time.Duration) { t.Error("a missing minter was retried") }
	if err := noMinter.configure(context.Background()); !errors.Is(err, errNoTalosMinter) {
		t.Errorf("a hetzner state with a talosconfig and no minter must fail on wiring, got %v", err)
	}
}

// The step boundaries are the whole soundness argument of deployKubeRefresher: each long wait must
// start on a freshly minted certificate. This pins that a kube.refresh call sits between every pair of
// consecutive long waits in RunDeployV2, so a new wait added without one fails here rather than as a
// 401 an hour into a customer's deploy.
func TestDeployRefreshesBeforeEveryLongWait(t *testing.T) {
	src, err := os.ReadFile("deploy.go")
	if err != nil {
		t.Fatal(err)
	}
	body := string(src)
	start := strings.Index(body, "kube := newDeployKubeRefresher(")
	if start < 0 {
		t.Fatal("RunDeployV2 no longer builds a deployKubeRefresher")
	}
	body = body[start:]
	if strings.Contains(body[:strings.Index(body, "func runnerIdentity(")], "provider.ConfigureKubeconfig(") {
		t.Error("the dedicated post-apply path calls provider.ConfigureKubeconfig directly, bypassing the re-mint")
	}
	// In source order. Each is bounded by its own timeout (15m, 15m, 20m, 15m, 15m, 10m), and none of
	// them may share a certificate with the one before it.
	waits := []string{
		"k8s.WaitClusterReady(",
		"k8s.WaitPodToAPIServer(",
		"installArgoCD(",
		"argocd.EnsureExternalSecretsStore(",
		"argocd.EnsureCertManagerIssuer(",
		"argocd.ApplyManifestAddOns(",
		"argocd.ApplyAddOnsInWaves(",
		"argocd.WaitAddOnsHealthy(",
		"bootstrapInClusterVault(",
	}
	prev := 0
	for i, w := range waits {
		at := strings.Index(body[prev:], w)
		if at < 0 {
			t.Fatalf("%s is no longer after %s in RunDeployV2 — update this list", w, waits[max(i-1, 0)])
		}
		at += prev
		if i > 0 && !strings.Contains(body[prev:at], "kube.refresh(") && !strings.Contains(body[prev:at], "kube.configure(") {
			t.Errorf("no kube.refresh between %s and %s — the second starts on the first's certificate", waits[i-1], w)
		}
		prev = at + len(w)
	}
}
