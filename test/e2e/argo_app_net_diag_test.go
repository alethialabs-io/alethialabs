// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// The shape run 36706460832 left behind for the staging loadgenerator, with the init container
// status the dump did not read then. Hand-written from the Pod API shape, not captured — the run
// printed only the main container's PodInitializing, which is the defect.
const stuckInitPodsJSON = `{"items": [
  {"metadata": {"name": "loadgenerator-5c7cbd94ff-crxrp"}, "spec": {"nodeName": "gke-n1"},
   "status": {"phase": "Pending", "conditions": [{"type": "PodScheduled", "status": "True"}, {"type": "Ready", "status": "False"}],
     "initContainerStatuses": [{"name": "frontend-check", "ready": false, "restartCount": 3,
        "state": {"waiting": {"reason": "CrashLoopBackOff", "message": "back-off 40s restarting failed container"}},
        "lastState": {"terminated": {"reason": "Error", "exitCode": 1}}}],
     "containerStatuses": [{"name": "main", "ready": false, "state": {"waiting": {"reason": "PodInitializing"}}}]}},
  {"metadata": {"name": "looping-now"}, "spec": {"nodeName": "gke-n2"},
   "status": {"phase": "Pending", "conditions": [{"type": "Ready", "status": "False"}],
     "initContainerStatuses": [
        {"name": "done-first", "ready": true, "state": {"terminated": {"reason": "Completed", "exitCode": 0}}},
        {"name": "waiting-on-peer", "ready": false, "restartCount": 1, "state": {"running": {"startedAt": "t"}}}],
     "containerStatuses": [{"name": "app", "ready": false, "state": {"waiting": {"reason": "PodInitializing"}}}]}},
  {"metadata": {"name": "frontend-1"}, "spec": {"nodeName": "gke-n1"},
   "status": {"phase": "Running", "conditions": [{"type": "Ready", "status": "True"}]}}
]}`

func TestParseNotReadyPodsNamesTheStuckInitContainer(t *testing.T) {
	lines, total, err := parseNotReadyPods([]byte(stuckInitPodsJSON))
	if err != nil {
		t.Fatal(err)
	}
	if total != 3 || len(lines) != 2 {
		t.Fatalf("total=%d notReady=%d (%v); want 3 and 2", total, len(lines), lines)
	}
	for _, want := range []string{
		"loadgenerator-5c7cbd94ff-crxrp phase=Pending node=gke-n1; init container frontend-check waiting CrashLoopBackOff: back-off 40s restarting failed container (restarts=3, last exit Error/1); container main waiting PodInitializing",
		"looping-now phase=Pending node=gke-n2; init container waiting-on-peer running (restarts=1); container app waiting PodInitializing",
	} {
		if !strings.Contains(strings.Join(lines, "\n"), want) {
			t.Errorf("missing %q\n--- got ---\n%s", want, strings.Join(lines, "\n"))
		}
	}
	if strings.Contains(strings.Join(lines, "\n"), "done-first") {
		t.Errorf("a completed init container is not a finding:\n%s", strings.Join(lines, "\n"))
	}
}

func TestStuckInitContainers(t *testing.T) {
	got := stuckInitContainers([]byte(stuckInitPodsJSON), 5)
	want := []stuckInit{
		{Pod: "loadgenerator-5c7cbd94ff-crxrp", Container: "frontend-check", Previous: true},
		{Pod: "looping-now", Container: "waiting-on-peer", Previous: false},
	}
	if len(got) != len(want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("[%d] got %+v, want %+v — a restarting container that is not running now must read its PREVIOUS log", i, got[i], want[i])
		}
	}
	if n := len(stuckInitContainers([]byte(stuckInitPodsJSON), 1)); n != 1 {
		t.Errorf("cap not honoured: %d", n)
	}
	if stuckInitContainers([]byte(boutiquePodsJSON), 5) != nil {
		t.Errorf("pods with no init containers produced stuck inits")
	}
}

func TestRenderInitContainerLogs(t *testing.T) {
	got := renderInitContainerLogs([]initLogRead{
		{stuckInit: stuckInit{Pod: "lg", Container: "frontend-check", Previous: true},
			Log: []byte("+ echo 'Attempt 12: Pinging frontend: frontend:80...'\nError: Could not reach frontend - Status code: \nFailed to reach frontend after 12 attempts.\n")},
		{stuckInit: stuckInit{Pod: "p2", Container: "c"}, Err: errors.New("exit status 1")},
		{stuckInit: stuckInit{Pod: "p3", Container: "c"}},
	})
	for _, want := range []string{
		"lg / frontend-check (PREVIOUS run (--previous; it is restarting)):",
		"| Error: Could not reach frontend - Status code:",
		"| Failed to reach frontend after 12 attempts.",
		"p2 / c (current run):",
		"could not read the log (exit status 1)",
		"p3 / c (current run):",
		"returned NOTHING",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q\n--- got ---\n%s", want, got)
		}
	}
	if renderInitContainerLogs(nil) != "" {
		t.Error("no stuck init container must add nothing to the dump")
	}
}

// guardrailPoliciesJSON returns the guardrail bundle as the API server lists it, converted from the
// file the runner applies (infra/templates/argocd/preview-guardrails/networkpolicy.yaml) rather than
// hand-copied: a hand-written copy went stale the moment #845's node-local DNS rule was added.
func guardrailPoliciesJSON(t *testing.T) []byte {
	t.Helper()
	f, err := os.Open("../../infra/templates/argocd/preview-guardrails/networkpolicy.yaml")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	dec := yaml.NewDecoder(f)
	var items []map[string]any
	for {
		var doc map[string]any
		err := dec.Decode(&doc)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		items = append(items, doc)
	}
	out, err := json.Marshal(map[string]any{"items": items})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestRenderNetworkPoliciesGuardrailBundle(t *testing.T) {
	got := renderNetworkPolicies("boutique-staging", guardrailPoliciesJSON(t), nil)
	for _, want := range []string{
		"NetworkPolicies in boutique-staging",
		"preview-default-deny: pods[{}] types=Ingress,Egress",
		"ingress: DENY all",
		"egress: DENY all",
		"egress to ns[kubernetes.io/metadata.name=kube-system] pods[k8s-app=kube-dns] on 53/UDP,53/TCP",
		// #845 gcp leg: the node-local DNS cache's link-local addresses, DNS ports only.
		"egress to ipBlock 169.254.20.10/32 | ipBlock 169.254.25.10/32 on 53/UDP,53/TCP",
		"ingress from same-ns pods[{}] on any port",
		"egress to same-ns pods[{}] on any port",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q\n--- got ---\n%s", want, got)
		}
	}
}

func TestRenderNetworkPoliciesEmptyAndErrors(t *testing.T) {
	if got := renderNetworkPolicies("ns", []byte(`{"items":[]}`), nil); !strings.Contains(got, "none — every pod here is non-isolated") {
		t.Errorf("empty list must say so:\n%s", got)
	}
	got := renderNetworkPolicies("ns", nil, errors.New("forbidden"))
	if !strings.Contains(got, "could not list NetworkPolicies (forbidden)") || strings.Contains(got, "none —") {
		t.Errorf("a failed read must never read as 'no policies':\n%s", got)
	}
}

func TestRenderDNSPeer(t *testing.T) {
	twoDNS := `{"items":[{"metadata":{"name":"kube-dns-a"},"status":{"conditions":[{"type":"Ready","status":"True"}]}},{"metadata":{"name":"kube-dns-b"},"status":{"conditions":[{"type":"Ready","status":"False"}]}}]}`
	svc := `{"spec":{"clusterIP":"10.1.0.10","selector":{"k8s-app":"kube-dns"}}}`
	none := `{"items":[]}`

	got := renderDNSPeer([]byte(twoDNS), nil, []byte(svc), nil, []byte(none), nil)
	for _, want := range []string{
		"kube-system pods k8s-app=kube-dns: 2 (1 Ready)",
		"Service kube-system/kube-dns: clusterIP=10.1.0.10 selector=k8s-app=kube-dns",
		"node-local DNS cache (pods k8s-app=node-local-dns, any ns): none",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q\n--- got ---\n%s", want, got)
		}
	}

	// The two shapes that make the DNS allow admit nothing, each said in words.
	got = renderDNSPeer([]byte(none), nil, []byte(svc), nil, []byte(twoDNS), nil)
	for _, want := range []string{"k8s-app=kube-dns: NONE — the DNS allow selects nothing", "2 (1 Ready) — pods resolve on the node"} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q\n--- got ---\n%s", want, got)
		}
	}

	// A failed read is UNKNOWN, never zero.
	got = renderDNSPeer(nil, errors.New("timeout"), nil, errors.New("forbidden"), nil, errors.New("timeout"))
	if strings.Contains(got, "NONE") || strings.Contains(got, ": none") {
		t.Errorf("a failed read rendered as an absence:\n%s", got)
	}
	for _, want := range []string{"k8s-app=kube-dns: UNKNOWN (timeout)", "kube-dns: unreadable (forbidden)", "any ns): UNKNOWN (timeout)"} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q\n--- got ---\n%s", want, got)
		}
	}
}

func TestRenderPolicyEngine(t *testing.T) {
	pods := `{"items":[
	  {"metadata":{"labels":{"k8s-app":"calico-node"}},"status":{"conditions":[{"type":"Ready","status":"True"}]}},
	  {"metadata":{"labels":{"k8s-app":"calico-node"}},"status":{"conditions":[{"type":"Ready","status":"False"}]}},
	  {"metadata":{"labels":{"k8s-app":"calico-typha"}},"status":{"conditions":[{"type":"Ready","status":"True"}]}}]}`
	got := renderPolicyEngine([]byte(pods), nil)
	for _, want := range []string{
		"calico-node: 1/2 Ready — NOT ALL READY",
		"calico-typha: 1/1 Ready\n",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q\n--- got ---\n%s", want, got)
		}
	}
	if got := renderPolicyEngine([]byte(`{"items":[]}`), nil); !strings.Contains(got, "none — no Calico or Cilium agent") {
		t.Errorf("an empty list must say so:\n%s", got)
	}
	if got := renderPolicyEngine(nil, errors.New("timeout")); !strings.Contains(got, "UNKNOWN (timeout)") || strings.Contains(got, "none") {
		t.Errorf("a failed read must read UNKNOWN:\n%s", got)
	}
}
