// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	"github.com/alethialabs-io/alethialabs/packages/core/k8s"
	"github.com/alethialabs-io/alethialabs/packages/core/tofu"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// defaultProbeTimeout bounds a single cluster-alive check. A dead apiserver must
// resolve to reachable=false quickly rather than hang the job.
const defaultProbeTimeout = 30 * time.Second

// ProbeDetail is the honest, structured, NON-SECRET detail of a cluster-alive probe.
// It mirrors the console's `ProbeDetail` jsonb (apps/console/types/jsonb.types.ts),
// stored on environment_probes.detail. Every field is optional: a probe records only
// what it could observe (an unreachable cluster fills Error and little else; a reachable
// one fills the health fields). It NEVER holds a secret — no kubeconfig, token, or cert.
type ProbeDetail struct {
	// Endpoint is the cluster API-server endpoint the probe dialed (host:port or URL).
	// Non-secret: it is the public control-plane address, not credential material.
	Endpoint string `json:"endpoint,omitempty"`
	// Method is how liveness was checked, e.g. "apiserver-readyz".
	Method string `json:"method,omitempty"`
	// StatusCode is the HTTP status the API-server health endpoint returned, when it answered.
	StatusCode int `json:"statusCode,omitempty"`
	// ServerVersion is the Kubernetes server version reported by a reachable API server.
	ServerVersion string `json:"serverVersion,omitempty"`
	// NodeCount / ReadyNodeCount are the nodes the probe saw (best-effort; omitted when
	// it did not list nodes, e.g. the API server was unreachable).
	NodeCount      int `json:"nodeCount,omitempty"`
	ReadyNodeCount int `json:"readyNodeCount,omitempty"`
	// LatencyMs is the round-trip latency of the liveness check, in milliseconds.
	LatencyMs int64 `json:"latencyMs,omitempty"`
	// Error is the failure reason when unreachable (dial error / TLS / timeout) — a
	// message, never a secret.
	Error string `json:"error,omitempty"`
}

// ProbeResult is the honest outcome of a cluster-alive probe. An UNREACHABLE cluster is a
// SUCCESSFUL probe with Reachable=false (the honest "it's down" signal) — NOT a job failure.
// It carries no secret and is safe for the runner to post to environment_probes.
type ProbeResult struct {
	// Reachable is true when the cluster API server answered the liveness probe.
	Reachable bool `json:"reachable"`
	// Message is a short human-readable summary for the console badge (esp. WHY unreachable).
	// Never a secret.
	Message string `json:"message,omitempty"`
	// Detail is the structured, non-secret probe detail (mirrors environment_probes.detail).
	Detail ProbeDetail `json:"detail"`
}

// ReadStateOutputsParams configures an in-process read of an environment's OpenTofu
// outputs from the console's http state proxy.
type ReadStateOutputsParams struct {
	// IacVersion is the OpenTofu version to init with (defaults to the pinned version).
	IacVersion string
	// StateBackend reads project tofu state from the console's per-job http proxy
	// (the same backend RunDeployV2 writes / RunDriftDetection reads). Required.
	StateBackend *cloud.HTTPBackendConfig
	Stdout       io.Writer
	Stderr       io.Writer
}

// ReadStateOutputs reads an environment's OpenTofu outputs from the console http state
// proxy WITHOUT running a plan, cloning any module, or copying any template. It stands up
// a throwaway workspace whose config is JUST a `backend "http" {}` block, inits it against
// the state proxy, and runs `tofu output -json` — which reads output values straight from
// the remote state (outputs are stored in state, so no providers/resources are needed).
//
// This is the cheap read the PROBE_CLUSTER path needs: hetzner/alibaba's kubeconfig is a
// (sensitive) tofu output that cannot be synthesized from a cluster name, so a liveness
// probe must read it — but only in-process.
//
// SECURITY INVARIANT: the returned outputs (which can include the sensitive `kubeconfig`
// output) stay IN-PROCESS ONLY. They are never written to the workdir (the http backend
// keeps state remote; the state token rides in TF_HTTP_PASSWORD, not on disk) and never
// logged: tofu-exec STREAMS `output -json` (values un-redacted) to its stdout writer, so we
// hand the tofu CLI io.Discard for stdout — the values reach the caller ONLY via the
// returned map. The throwaway workspace is removed on return. Callers MUST NOT persist them.
func ReadStateOutputs(ctx context.Context, params ReadStateOutputsParams) (map[string]interface{}, error) {
	if params.StateBackend == nil {
		return nil, fmt.Errorf("StateBackend config is required for state access")
	}
	stderr := params.Stderr
	if stderr == nil {
		stderr = os.Stderr
	}
	stdout := params.Stdout
	if stdout == nil {
		stdout = os.Stdout
	}
	// SECURITY: tofu-exec STREAMS `output -json` (which includes sensitive values like the
	// kubeconfig — `-json` never redacts) to the CLI's stdout writer. So the tofu CLI is
	// given io.Discard for stdout: the output values are returned via the map, never echoed
	// to the caller's log writer. tofu errors still flow to `stderr`. We emit our own
	// non-secret progress line to the real stdout instead.
	fmt.Fprintln(stdout, "Reading environment outputs from the state proxy (in-process, not persisted)...")

	tmpDir, err := os.MkdirTemp("", "alethia-readstate-*")
	if err != nil {
		return nil, fmt.Errorf("failed to create temp dir: %w", err)
	}
	// The workspace only ever holds a backend-only main.tf + backend.hcl (NO secrets, NO
	// state file — the http backend keeps state remote). Removed unconditionally on return.
	defer os.RemoveAll(tmpDir)

	// A config that declares ONLY the http backend. `tofu output` reads outputs from the
	// remote state, so it needs no providers, resources, or output blocks of its own.
	mainTF := "terraform {\n  backend \"http\" {}\n}\n"
	if err := os.WriteFile(filepath.Join(tmpDir, "main.tf"), []byte(mainTF), 0o600); err != nil {
		return nil, fmt.Errorf("failed to write state-read config: %w", err)
	}

	tf, err := tofu.NewTofuCLI(ctx, params.IacVersion, tmpDir, io.Discard, stderr)
	if err != nil {
		return nil, fmt.Errorf("tofu init failed: %w", err)
	}

	backendFile, err := params.StateBackend.WriteBackendHCL(tmpDir)
	if err != nil {
		return nil, fmt.Errorf("failed to write backend config: %w", err)
	}

	restoreStateAuth := params.StateBackend.SetAuthEnv()
	defer restoreStateAuth()

	if err := tf.InitWithBackendFile(ctx, backendFile, false); err != nil {
		return nil, fmt.Errorf("tofu init failed: %w", err)
	}

	outputs, err := tf.Output(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to read tofu outputs from state: %w", err)
	}
	return outputs, nil
}

// ProbeParams configures a cluster-alive (PROBE_CLUSTER) run.
type ProbeParams struct {
	// ProjectConfig identifies the environment being probed. Required.
	ProjectConfig *types.ProjectConfig
	// Provider is the cloud slug (aws/gcp/azure/hetzner/alibaba). Required.
	Provider string
	// IacVersion is the OpenTofu version used to read state (optional; defaults).
	IacVersion string
	// StateBackend reads the environment's tofu outputs (incl. the kubeconfig for
	// hetzner/alibaba) from the console http proxy. Required.
	StateBackend *cloud.HTTPBackendConfig
	// Timeout bounds the reachability check (defaults to defaultProbeTimeout).
	Timeout time.Duration
	Stdout  io.Writer
	Stderr  io.Writer
}

// RunProbe answers "is the customer's cluster actually reachable RIGHT NOW?" — the live
// half of day-2, alongside drift. It reads the environment's tofu outputs in-process from
// the state proxy (ReadStateOutputs), acquires the cluster kubeconfig via the provider
// (hetzner/alibaba read the sensitive `kubeconfig` output; aws/gcp/azure synthesize an
// exec-plugin kubeconfig from the cluster name), then does a bounded liveness dial of the
// API server (`/readyz`), enriching a reachable result with server version + node readiness.
//
// FAIL-CLOSED-TO-HONEST-DOWN: a cluster that cannot be reached — no kubeconfig output, a
// kubeconfig-configuration failure, or an API server that does not answer — is a SUCCESSFUL
// probe with Reachable=false, NEVER a returned error. A returned error is reserved for the
// probe being UNABLE TO RUN (nil params, or the state proxy itself being unreadable) — an
// operational failure distinct from an honest "the cluster is down".
//
// The kubeconfig is read only in-process and written only to the provider's private,
// per-worker 0600 kubeconfig file (the same path the deploy path uses); it is NEVER placed
// in ProbeResult, logged, or persisted. Cloud creds are assumed already activated by the
// caller (the runner), mirroring InspectCluster.
func RunProbe(ctx context.Context, params ProbeParams) (*ProbeResult, error) {
	vc := params.ProjectConfig
	if vc == nil {
		return nil, fmt.Errorf("ProjectConfig is required for RunProbe")
	}
	if params.StateBackend == nil {
		return nil, fmt.Errorf("StateBackend config is required for state access")
	}
	stdout := params.Stdout
	if stdout == nil {
		stdout = os.Stdout
	}
	stderr := params.Stderr
	if stderr == nil {
		stderr = os.Stderr
	}
	timeout := params.Timeout
	if timeout <= 0 {
		timeout = defaultProbeTimeout
	}

	provider, err := cloud.NewCloudProvider(params.Provider)
	if err != nil {
		// An unknown/unsupported provider is a config error the probe cannot run against.
		return nil, fmt.Errorf("probe cannot run: %w", err)
	}

	// 1. Read the environment's outputs from the state proxy, in-process only.
	outputs, err := ReadStateOutputs(ctx, ReadStateOutputsParams{
		IacVersion:   params.IacVersion,
		StateBackend: params.StateBackend,
		Stdout:       stdout,
		Stderr:       stderr,
	})
	if err != nil {
		// The state proxy itself is unreadable — the probe could not RUN. This is an
		// operational error, not an honest "cluster down".
		return nil, fmt.Errorf("probe could not read environment state: %w", err)
	}

	// The API-server endpoint is a non-secret detail we can report even when unreachable.
	endpoint := cloud.ExtractClusterEndpoint(outputs)

	// 2. Acquire kubeconfig via the provider. Merge a synthesized cluster-name entry so
	//    aws/gcp/azure (which build an exec-plugin kubeconfig from the name) still work when
	//    that output is absent — mirrors InspectCluster. A configuration failure here means
	//    we have no way to reach the cluster: honest Reachable=false, NOT a job error.
	merged := map[string]interface{}{}
	for k, v := range outputs {
		merged[k] = v
	}
	if _, ok := merged[clusterNameOutputKey(params.Provider)]; !ok && vc.Cluster.ClusterName != "" {
		merged[clusterNameOutputKey(params.Provider)] = vc.Cluster.ClusterName
	}
	if err := provider.ConfigureKubeconfig(ctx, vc, merged, stdout); err != nil {
		// Sanitize: ConfigureKubeconfig errors describe the missing/invalid output, not
		// secret material — but scrub to a short message and never echo the outputs.
		reason := sanitizeProbeError(err.Error())
		fmt.Fprintf(stderr, "Probe: cluster unreachable (kubeconfig unavailable): %s\n", reason)
		return &ProbeResult{
			Reachable: false,
			Message:   "cluster unreachable: kubeconfig unavailable",
			Detail:    ProbeDetail{Endpoint: endpoint, Method: probeMethod, Error: reason},
		}, nil
	}

	// 3. Bounded liveness dial of the API server.
	result := probeAPIServer(ctx, timeout, endpoint, stdout, stderr)
	return result, nil
}

// probeMethod names the liveness mechanism recorded on ProbeDetail.
const probeMethod = "apiserver-readyz"

// probeAPIServer performs the bounded reachability check against the kubeconfig the caller
// already configured (KUBECONFIG is set by ConfigureKubeconfig). It dials the API server's
// `/readyz` health endpoint; on success it best-effort enriches the result with the server
// version and node readiness. It NEVER returns an error: an API server that does not answer
// within the timeout is an honest Reachable=false. All kubectl invocations are bounded by
// both a per-call --request-timeout and the context deadline so a dead endpoint cannot hang.
func probeAPIServer(ctx context.Context, timeout time.Duration, endpoint string, stdout, stderr io.Writer) *ProbeResult {
	detail := ProbeDetail{Endpoint: endpoint, Method: probeMethod}

	fmt.Fprintf(stdout, "Probing cluster API server liveness (/readyz, timeout %s)...\n", timeout)
	start := time.Now()
	out, err := runKubectlBounded(ctx, timeout, "get", "--raw=/readyz")
	detail.LatencyMs = time.Since(start).Milliseconds()

	if err != nil || strings.TrimSpace(out) != "ok" {
		reason := "API server did not answer /readyz within the probe timeout"
		if err != nil {
			reason = sanitizeProbeError(err.Error())
		} else if trimmed := strings.TrimSpace(out); trimmed != "" {
			// The endpoint answered but not "ok" (e.g. not-yet-ready) — record what it said.
			reason = "API server /readyz returned: " + truncate(trimmed, 200)
		}
		fmt.Fprintf(stderr, "Probe: cluster unreachable: %s\n", reason)
		detail.Error = reason
		return &ProbeResult{
			Reachable: false,
			Message:   "cluster unreachable",
			Detail:    detail,
		}
	}

	detail.StatusCode = 200 // `/readyz` answered "ok"
	fmt.Fprintln(stdout, "Probe: cluster API server is reachable (/readyz=ok).")

	// Best-effort enrichment — a failure here does NOT flip reachable (the API answered).
	if v := probeServerVersion(ctx, timeout); v != "" {
		detail.ServerVersion = v
	}
	if total, ready, ok := probeNodeReadiness(ctx, timeout); ok {
		detail.NodeCount = total
		detail.ReadyNodeCount = ready
	}

	return &ProbeResult{
		Reachable: true,
		Message:   "cluster reachable",
		Detail:    detail,
	}
}

// probeServerVersion best-effort reads the Kubernetes server version from a reachable API
// server. Returns "" on any failure (enrichment only).
func probeServerVersion(ctx context.Context, timeout time.Duration) string {
	out, err := runKubectlBounded(ctx, timeout, "version", "-o", "json")
	if err != nil {
		return ""
	}
	return parseServerVersion([]byte(out))
}

// parseServerVersion pulls serverVersion.gitVersion from `kubectl version -o json` output.
// Pure (unit-testable); returns "" when the field is absent or the JSON is unparseable.
func parseServerVersion(raw []byte) string {
	var v struct {
		ServerVersion struct {
			GitVersion string `json:"gitVersion"`
		} `json:"serverVersion"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		return ""
	}
	return v.ServerVersion.GitVersion
}

// probeNodeReadiness best-effort counts total/Ready nodes on a reachable cluster. The bool
// is false (and counts ignored) when the node list could not be read.
func probeNodeReadiness(ctx context.Context, timeout time.Duration) (total, ready int, ok bool) {
	out, err := runKubectlBounded(ctx, timeout, "get", "nodes", "-o", "json")
	if err != nil {
		return 0, 0, false
	}
	r, t, perr := k8s.CountReadyNodes([]byte(out))
	if perr != nil {
		return 0, 0, false
	}
	return t, r, true
}

// runKubectlBounded runs `kubectl <args...>` against the configured KUBECONFIG, bounded by
// BOTH a kubectl --request-timeout AND the context deadline, so a dead API endpoint fails
// fast instead of hanging. KUBECONFIG is inherited from the process env (set by the
// provider's ConfigureKubeconfig).
//
// It captures stdout and stderr SEPARATELY and returns only stdout: the `/readyz` body ("ok")
// arrives on stdout, while kubectl warnings (version-skew notices, HTTP Warning headers) go
// to stderr — folding them together (CombinedOutput) would poison the exact-"ok" match and
// FALSELY report a healthy cluster unreachable. On failure the reason is taken from stderr
// (kubectl's human-readable dial/auth error), never from a bearer token.
func runKubectlBounded(ctx context.Context, timeout time.Duration, args ...string) (string, error) {
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	// Give kubectl its own request timeout slightly under the context bound so it returns a
	// clean dial error rather than being SIGKILLed at the context deadline.
	reqTimeout := timeout - 2*time.Second
	if reqTimeout < 2*time.Second {
		reqTimeout = 2 * time.Second
	}
	full := append([]string{fmt.Sprintf("--request-timeout=%s", reqTimeout.String())}, args...)
	cmd := exec.CommandContext(cctx, "kubectl", full...)
	var stdoutBuf, stderrBuf bytes.Buffer
	cmd.Stdout = &stdoutBuf
	cmd.Stderr = &stderrBuf
	if err := cmd.Run(); err != nil {
		reason := strings.TrimSpace(stderrBuf.String())
		if reason == "" {
			reason = strings.TrimSpace(stdoutBuf.String())
		}
		if reason == "" {
			reason = err.Error()
		}
		return "", fmt.Errorf("%s", sanitizeProbeError(reason))
	}
	return stdoutBuf.String(), nil
}

// sanitizeProbeError trims a probe failure message to a short, single-line, non-secret
// summary. Probe failures name endpoints and dial errors (all non-secret) — never client
// certs or tokens — but we still cap length and collapse newlines to keep the honest signal
// tidy and defend against an unexpectedly verbose upstream message.
func sanitizeProbeError(msg string) string {
	msg = strings.TrimSpace(msg)
	msg = strings.ReplaceAll(msg, "\n", " ")
	msg = strings.Join(strings.Fields(msg), " ")
	if msg == "" {
		return "unknown probe failure"
	}
	return truncate(msg, 300)
}

// truncate shortens s to at most n runes, appending an ellipsis when cut.
func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}
