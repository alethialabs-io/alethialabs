// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// stubKubectl puts a scripted `kubectl` at the front of PATH. The script dispatches on the joined
// argument list, so the bounded-probe helpers can be driven end-to-end without a cluster and
// without asserting on wall-clock behaviour.
func stubKubectl(t *testing.T, script string) {
	t.Helper()
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "kubectl"), []byte(script), 0o755); err != nil {
		t.Fatalf("write kubectl stub: %v", err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
}

// healthyKubectl answers /readyz, version and nodes for a two-node cluster with one node Ready.
const healthyKubectl = `#!/bin/sh
case "$*" in
  *--raw=/readyz*) printf 'ok'; exit 0;;
  *"version -o json"*) printf '{"serverVersion":{"gitVersion":"v1.31.4"}}'; exit 0;;
  *"get nodes -o json"*) printf '{"items":[{"status":{"conditions":[{"type":"Ready","status":"True"}]}},{"status":{"conditions":[{"type":"Ready","status":"False"}]}}]}'; exit 0;;
esac
exit 1
`

// TestProbeAPIServerReachableEnrichesDetail drives the reachable path: /readyz answers "ok", and the
// best-effort enrichment fills the server version and node counts.
func TestProbeAPIServerReachableEnrichesDetail(t *testing.T) {
	stubKubectl(t, healthyKubectl)

	var out strings.Builder
	res := probeAPIServer(context.Background(), 10*time.Second, "https://api.example.com", &out, io.Discard)
	if !res.Reachable {
		t.Fatalf("Reachable = false, detail = %+v", res.Detail)
	}
	if res.Message != "cluster reachable" {
		t.Errorf("Message = %q", res.Message)
	}
	if res.Detail.StatusCode != 200 {
		t.Errorf("StatusCode = %d, want 200", res.Detail.StatusCode)
	}
	if res.Detail.Method != probeMethod || res.Detail.Endpoint != "https://api.example.com" {
		t.Errorf("Detail = %+v", res.Detail)
	}
	if res.Detail.ServerVersion != "v1.31.4" {
		t.Errorf("ServerVersion = %q, want v1.31.4", res.Detail.ServerVersion)
	}
	if res.Detail.NodeCount != 2 || res.Detail.ReadyNodeCount != 1 {
		t.Errorf("nodes = %d/%d, want 1 ready of 2", res.Detail.ReadyNodeCount, res.Detail.NodeCount)
	}
	if res.Detail.Error != "" {
		t.Errorf("Error = %q, want empty on a reachable cluster", res.Detail.Error)
	}
	if !strings.Contains(out.String(), "/readyz=ok") {
		t.Errorf("stdout = %q", out.String())
	}
}

// TestProbeAPIServerRecordsWhatReadyzSaid covers the "answered, but not ok" branch — the endpoint
// replied, so the reason must quote what it said rather than claim a timeout.
func TestProbeAPIServerRecordsWhatReadyzSaid(t *testing.T) {
	stubKubectl(t, `#!/bin/sh
case "$*" in
  *--raw=/readyz*) printf 'poststarthook/rbac not finished'; exit 0;;
esac
exit 1
`)
	res := probeAPIServer(context.Background(), 10*time.Second, "https://api.example.com", io.Discard, io.Discard)
	if res.Reachable {
		t.Fatal("Reachable = true for a non-ok /readyz")
	}
	if !strings.Contains(res.Detail.Error, "API server /readyz returned: poststarthook/rbac not finished") {
		t.Fatalf("Detail.Error = %q", res.Detail.Error)
	}
	if res.Detail.StatusCode != 0 || res.Detail.ServerVersion != "" {
		t.Errorf("an unreachable probe must not be enriched: %+v", res.Detail)
	}
}

// TestProbeAPIServerUnreachableIsHonestDown covers the dial-failure branch: the probe NEVER errors,
// it records the sanitized kubectl reason and reports an honest Reachable=false.
func TestProbeAPIServerUnreachableIsHonestDown(t *testing.T) {
	stubKubectl(t, `#!/bin/sh
echo "Unable to connect to the server: dial tcp 10.0.0.1:443: i/o timeout" >&2
exit 1
`)
	var errOut strings.Builder
	res := probeAPIServer(context.Background(), 5*time.Second, "https://api.example.com", io.Discard, &errOut)
	if res.Reachable {
		t.Fatal("Reachable = true for a dial failure")
	}
	if res.Message != "cluster unreachable" {
		t.Errorf("Message = %q", res.Message)
	}
	if !strings.Contains(res.Detail.Error, "Unable to connect to the server") {
		t.Fatalf("Detail.Error = %q, want the sanitized kubectl reason", res.Detail.Error)
	}
	if strings.Contains(res.Detail.Error, "\n") {
		t.Errorf("Detail.Error is multi-line: %q", res.Detail.Error)
	}
	if !strings.Contains(errOut.String(), "Probe: cluster unreachable") {
		t.Errorf("stderr = %q", errOut.String())
	}
}

// TestProbeEnrichmentDegradesQuietly pins that the two enrichment reads are best-effort: an
// unparseable version payload and an unreadable node list yield empty/false, never a failure.
func TestProbeEnrichmentDegradesQuietly(t *testing.T) {
	stubKubectl(t, `#!/bin/sh
case "$*" in
  *"version -o json"*) printf 'not json'; exit 0;;
esac
exit 1
`)
	if got := probeServerVersion(context.Background(), 5*time.Second); got != "" {
		t.Errorf("probeServerVersion on unparseable output = %q, want empty", got)
	}
	if total, ready, ok := probeNodeReadiness(context.Background(), 5*time.Second); ok {
		t.Errorf("probeNodeReadiness on a failed read = (%d, %d, true), want ok=false", total, ready)
	}

	// A node list that parses to zero nodes is a SUCCESSFUL read of an empty cluster.
	stubKubectl(t, `#!/bin/sh
case "$*" in
  *"get nodes -o json"*) printf '{"items":[]}'; exit 0;;
esac
exit 1
`)
	total, ready, ok := probeNodeReadiness(context.Background(), 5*time.Second)
	if !ok || total != 0 || ready != 0 {
		t.Errorf("probeNodeReadiness on an empty cluster = (%d, %d, %v), want (0, 0, true)", total, ready, ok)
	}
}

// TestRunKubectlBoundedKeepsStderrOutOfStdout pins the separate-capture rule: a kubectl warning on
// stderr must not poison the exact-"ok" match that decides reachability.
func TestRunKubectlBoundedKeepsStderrOutOfStdout(t *testing.T) {
	stubKubectl(t, `#!/bin/sh
echo "Warning: v1 Ingress is deprecated" >&2
printf 'ok'
exit 0
`)
	out, err := runKubectlBounded(context.Background(), 10*time.Second, "get", "--raw=/readyz")
	if err != nil {
		t.Fatalf("runKubectlBounded: %v", err)
	}
	if out != "ok" {
		t.Fatalf("stdout = %q, want exactly \"ok\" (stderr must be captured separately)", out)
	}
}

// TestRunKubectlBoundedReportsStdoutWhenStderrIsEmpty covers the reason-fallback ladder: with an
// empty stderr the failure reason is taken from stdout rather than a bare exec error.
func TestRunKubectlBoundedReportsStdoutWhenStderrIsEmpty(t *testing.T) {
	stubKubectl(t, `#!/bin/sh
printf 'error: the server doesn'"'"'t have a resource type "nodes"'
exit 1
`)
	if _, err := runKubectlBounded(context.Background(), 10*time.Second, "get", "nodes"); err == nil {
		t.Fatal("runKubectlBounded returned nil for a failing kubectl")
	} else if !strings.Contains(err.Error(), `doesn't have a resource type`) {
		t.Fatalf("err = %v, want the stdout-derived reason", err)
	}
}
