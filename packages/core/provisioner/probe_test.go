// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// seedTestState POSTs a valid tfstate v4 carrying `outputs` to the in-memory state proxy so
// ReadStateOutputs/RunProbe can read them back through the real http backend. The state
// address mirrors testStateBackend (JobID "e2e-local").
func seedTestState(t *testing.T, srv *httptest.Server, outputs map[string]any) {
	t.Helper()
	stateOutputs := map[string]any{}
	for k, v := range outputs {
		stateOutputs[k] = map[string]any{"value": v, "type": "string"}
	}
	state := map[string]any{
		"version":           4,
		"terraform_version": "1.12.3",
		"serial":            1,
		"lineage":           "probe-test",
		"outputs":           stateOutputs,
		"resources":         []any{},
	}
	body, err := json.Marshal(state)
	if err != nil {
		t.Fatalf("marshal state: %v", err)
	}
	addr := srv.URL + "/api/jobs/e2e-local/state"
	req, err := http.NewRequest(http.MethodPost, addr, bytes.NewReader(body))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("seed state POST: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("seed state POST status = %d", resp.StatusCode)
	}
}

func requireTofuOrSkip(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("tofu"); err != nil {
		t.Skip("tofu not on PATH — skipping the state-proxy read test")
	}
}

func requireKubectlOrSkip(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("kubectl"); err != nil {
		t.Skip("kubectl not on PATH — skipping the reachability test")
	}
}

// TestReadStateOutputs_RequiresBackend asserts a nil StateBackend is a hard error (the
// probe cannot read state without the proxy config).
func TestReadStateOutputs_RequiresBackend(t *testing.T) {
	_, err := ReadStateOutputs(context.Background(), ReadStateOutputsParams{})
	if err == nil || !strings.Contains(err.Error(), "StateBackend") {
		t.Fatalf("expected a StateBackend-required error, got: %v", err)
	}
}

// TestReadStateOutputs_ReadsRemoteOutputsInProcess drives the REAL state-proxy path: it
// seeds the in-memory tofu http backend with a state carrying a (sensitive) kubeconfig
// output + a cluster-name output, then proves ReadStateOutputs reads them back in-process
// WITHOUT persisting or LOGGING the sensitive value.
func TestReadStateOutputs_ReadsRemoteOutputsInProcess(t *testing.T) {
	requireTofuOrSkip(t)
	srv := startTestStateServer(t)
	const secretKubeconfig = "apiVersion: v1\nkind: Config\n# SECRET-KUBECONFIG-MARKER-xyz\n"
	seedTestState(t, srv, map[string]any{
		"kubeconfig":             secretKubeconfig,
		"talos_cluster_name":     "acme-prod",
		"talos_cluster_endpoint": "https://1.2.3.4:6443",
	})

	var out, errBuf bytes.Buffer
	outputs, err := ReadStateOutputs(context.Background(), ReadStateOutputsParams{
		StateBackend: testStateBackend(srv),
		Stdout:       &out,
		Stderr:       &errBuf,
	})
	if err != nil {
		t.Fatalf("ReadStateOutputs: %v\nstdout:%s\nstderr:%s", err, out.String(), errBuf.String())
	}

	// The outputs are returned in-process (the whole point — hetzner/alibaba need the
	// sensitive kubeconfig output that can't be synthesized).
	if got, _ := outputs["kubeconfig"].(string); got != secretKubeconfig {
		t.Fatalf("kubeconfig output not read back in-process: got %q", got)
	}
	if got := cloud.ExtractClusterName(outputs); got != "acme-prod" {
		t.Fatalf("cluster-name output = %q, want acme-prod", got)
	}
	if got := cloud.ExtractClusterEndpoint(outputs); got != "https://1.2.3.4:6443" {
		t.Fatalf("endpoint output = %q", got)
	}

	// NEVER-LOGGED invariant: the sensitive kubeconfig value must not appear in the tofu
	// chatter routed to stdout/stderr (tofu-exec captures `output -json` into the map — it
	// does not echo output values). This is the log-leak half of "in-process only".
	if strings.Contains(out.String(), "SECRET-KUBECONFIG-MARKER") ||
		strings.Contains(errBuf.String(), "SECRET-KUBECONFIG-MARKER") {
		t.Fatal("the sensitive kubeconfig output leaked into the probe logs")
	}
}

// TestRunProbe_RequiresParams asserts the run-blocking preconditions error (distinct from
// an honest reachable=false).
func TestRunProbe_RequiresParams(t *testing.T) {
	srv := startTestStateServer(t)
	// nil ProjectConfig.
	if _, err := RunProbe(context.Background(), ProbeParams{
		Provider: "hetzner", StateBackend: testStateBackend(srv),
	}); err == nil || !strings.Contains(err.Error(), "ProjectConfig") {
		t.Fatalf("expected ProjectConfig-required error, got: %v", err)
	}
	// nil StateBackend.
	if _, err := RunProbe(context.Background(), ProbeParams{
		ProjectConfig: newLocalProjectConfig("acme", "prod"), Provider: "hetzner",
	}); err == nil || !strings.Contains(err.Error(), "StateBackend") {
		t.Fatalf("expected StateBackend-required error, got: %v", err)
	}
	// Unknown provider is a config error the probe can't run against (NOT reachable=false).
	if _, err := RunProbe(context.Background(), ProbeParams{
		ProjectConfig: newLocalProjectConfig("acme", "prod"), Provider: "nope",
		StateBackend: testStateBackend(srv),
	}); err == nil {
		t.Fatal("expected an unknown-provider error")
	}
}

// TestRunProbe_UnreachableIsHonestSuccess is the core honest-signal proof WITHOUT docker.
// It seeds the state proxy with a real (secret-bearing) kubeconfig whose server points at a
// GENUINELY-DEAD endpoint (a closed local port), then proves RunProbe:
//   - dials it for real and returns Reachable=false (NOT a hardcoded value — LatencyMs>0 and
//     the error names a real dial failure),
//   - returns a nil error (unreachable = job SUCCESS, distinct from a job failure),
//   - never leaks the kubeconfig token into the ProbeResult or the logs.
func TestRunProbe_UnreachableIsHonestSuccess(t *testing.T) {
	requireTofuOrSkip(t)
	requireKubectlOrSkip(t)

	srv := startTestStateServer(t)
	// A valid kubeconfig kubectl will parse and dial — server is a closed port (127.0.0.1:1)
	// so the dial genuinely fails (connection refused). It carries a fake SECRET token so we
	// can prove it never lands in the result or the logs.
	const secretToken = "SECRET-TOKEN-DO-NOT-LEAK-abc123"
	deadKubeconfig := "apiVersion: v1\n" +
		"kind: Config\n" +
		"clusters:\n" +
		"- name: dead\n" +
		"  cluster:\n" +
		"    server: https://127.0.0.1:1\n" +
		"    insecure-skip-tls-verify: true\n" +
		"contexts:\n" +
		"- name: dead\n" +
		"  context: {cluster: dead, user: dead}\n" +
		"current-context: dead\n" +
		"users:\n" +
		"- name: dead\n" +
		"  user: {token: \"" + secretToken + "\"}\n"
	seedTestState(t, srv, map[string]any{
		"kubeconfig":             deadKubeconfig,
		"talos_cluster_name":     "acme-prod",
		"talos_cluster_endpoint": "https://127.0.0.1:1",
	})

	var out, errBuf bytes.Buffer
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	res, err := RunProbe(ctx, ProbeParams{
		ProjectConfig: newLocalProjectConfig("acme", "prod"),
		Provider:      "hetzner", // reads the raw kubeconfig output, no cloud creds
		StateBackend:  testStateBackend(srv),
		Timeout:       6 * time.Second,
		Stdout:        &out,
		Stderr:        &errBuf,
	})

	// SUCCESS-with-false: unreachable is NOT a job failure.
	if err != nil {
		t.Fatalf("RunProbe returned an error for an unreachable cluster (must be SUCCESS reachable=false): %v", err)
	}
	if res == nil {
		t.Fatal("RunProbe returned nil result")
	}
	if res.Reachable {
		t.Fatalf("expected Reachable=false for a dead endpoint, got true (detail: %+v)", res.Detail)
	}
	// Non-vacuous: the probe actually DIALED (latency recorded) and reports a real reason.
	if res.Detail.LatencyMs <= 0 {
		t.Fatalf("LatencyMs = %d — the probe did not actually dial the endpoint", res.Detail.LatencyMs)
	}
	if res.Detail.Error == "" {
		t.Fatal("expected a non-empty failure reason on the unreachable path")
	}
	if res.Detail.Endpoint != "https://127.0.0.1:1" {
		t.Fatalf("endpoint detail = %q, want the dialed endpoint", res.Detail.Endpoint)
	}

	// NEVER-PERSISTED / NEVER-LOGGED: the secret kubeconfig token must not appear anywhere in
	// the marshaled result nor the probe logs.
	resJSON, _ := json.Marshal(res)
	if strings.Contains(string(resJSON), secretToken) {
		t.Fatal("the kubeconfig token leaked into the ProbeResult")
	}
	if strings.Contains(out.String(), secretToken) || strings.Contains(errBuf.String(), secretToken) {
		t.Fatal("the kubeconfig token leaked into the probe logs")
	}
}

// TestParseServerVersion covers the pure version extraction.
func TestParseServerVersion(t *testing.T) {
	raw := []byte(`{"serverVersion":{"gitVersion":"v1.31.0"},"clientVersion":{"gitVersion":"v1.30.0"}}`)
	if got := parseServerVersion(raw); got != "v1.31.0" {
		t.Fatalf("parseServerVersion = %q, want v1.31.0", got)
	}
	if got := parseServerVersion([]byte(`not json`)); got != "" {
		t.Fatalf("parseServerVersion(bad) = %q, want empty", got)
	}
	if got := parseServerVersion([]byte(`{"clientVersion":{"gitVersion":"v1"}}`)); got != "" {
		t.Fatalf("parseServerVersion(no server) = %q, want empty", got)
	}
}

// TestSanitizeProbeError asserts the reason is collapsed to a single tidy line and capped.
func TestSanitizeProbeError(t *testing.T) {
	if got := sanitizeProbeError("  dial tcp 1.2.3.4:6443:\nconnection refused  "); got != "dial tcp 1.2.3.4:6443: connection refused" {
		t.Fatalf("sanitizeProbeError collapse = %q", got)
	}
	if got := sanitizeProbeError(""); got != "unknown probe failure" {
		t.Fatalf("sanitizeProbeError(empty) = %q", got)
	}
	long := strings.Repeat("x", 500)
	if got := sanitizeProbeError(long); len([]rune(got)) > 301 {
		t.Fatalf("sanitizeProbeError did not cap length: %d runes", len([]rune(got)))
	}
}

// TestProbeResult_MarshalsHonestShape asserts the ProbeResult JSON matches the console's
// environment_probes contract (reachable + message + detail).
func TestProbeResult_MarshalsHonestShape(t *testing.T) {
	res := &ProbeResult{
		Reachable: true,
		Message:   "cluster reachable",
		Detail: ProbeDetail{
			Endpoint: "https://1.2.3.4:6443", Method: "apiserver-readyz",
			StatusCode: 200, ServerVersion: "v1.31.0", NodeCount: 3, ReadyNodeCount: 3, LatencyMs: 42,
		},
	}
	b, err := json.Marshal(res)
	if err != nil {
		t.Fatal(err)
	}
	var back struct {
		Reachable bool        `json:"reachable"`
		Message   string      `json:"message"`
		Detail    ProbeDetail `json:"detail"`
	}
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatal(err)
	}
	if !back.Reachable || back.Detail.StatusCode != 200 || back.Detail.ServerVersion != "v1.31.0" || back.Detail.ReadyNodeCount != 3 {
		t.Fatalf("ProbeResult round-trip lost fields: %s", b)
	}
	// A false result omits the health fields (omitempty) but keeps reachable=false explicit.
	down, _ := json.Marshal(&ProbeResult{Reachable: false, Message: "cluster unreachable", Detail: ProbeDetail{Error: "refused"}})
	if !strings.Contains(string(down), `"reachable":false`) {
		t.Fatalf("false result must carry explicit reachable:false, got %s", down)
	}
}

// compile-time: ensure the provider slug helper stays aligned with the enum type.
var _ = types.CloudProviderHetzner
