// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

import (
	"errors"
	"strings"
	"testing"
)

// The shape run 36648775773 left behind: synced fine, Degraded, with a Deployment whose Pod the
// scheduler could not place. Hand-written from the Application/Pod API shapes, not captured — the
// run printed none of it, which is the defect.
const degradedAppJSON = `{
  "spec": {"source": {"repoURL": "r", "path": "examples/online-boutique/overlays/staging"}, "destination": {"namespace": "boutique-staging"}, "syncPolicy": {"automated": {}}},
  "status": {
    "health": {"status": "Degraded"},
    "sync": {"status": "Synced"},
    "operationState": {"phase": "Succeeded", "message": "successfully synced (all tasks run)"},
    "resources": [
      {"kind": "Service", "namespace": "boutique-staging", "name": "frontend", "status": "Synced", "health": {"status": "Healthy"}},
      {"kind": "ConfigMap", "namespace": "boutique-staging", "name": "cfg", "status": "Synced"},
      {"kind": "Deployment", "namespace": "boutique-staging", "name": "frontend", "status": "Synced", "health": {"status": "Degraded", "message": "Deployment \"frontend\" exceeded its progress deadline"}},
      {"kind": "Deployment", "namespace": "boutique-staging", "name": "cartservice", "status": "Synced", "health": {"status": "Progressing", "message": "Waiting for rollout to finish: 0 of 1 updated replicas are available..."}}
    ]
  }
}`

func TestRenderArgoAppDiagnosisNamesTheUnhealthyResources(t *testing.T) {
	got := renderArgoAppDiagnosis("app-staging", []byte(degradedAppJSON), nil, "", "", nil)
	for _, want := range []string{
		"resources ArgoCD reports as not Healthy:",
		`Deployment/frontend in boutique-staging: health=Degraded — Deployment "frontend" exceeded its progress deadline`,
		"Deployment/cartservice in boutique-staging: health=Progressing",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q\n--- got ---\n%s", want, got)
		}
	}
	for _, noise := range []string{"Service/frontend", "ConfigMap/cfg"} {
		if strings.Contains(got, noise) {
			t.Errorf("a Healthy / verdict-less resource was printed (%s):\n%s", noise, got)
		}
	}
}

func TestRenderArgoUnhealthyResourcesIsCapped(t *testing.T) {
	var items []string
	for i := 0; i < 40; i++ {
		items = append(items, `{"kind":"Deployment","name":"d","health":{"status":"Degraded"}}`)
	}
	got := renderArgoUnhealthyResources([]byte(`{"status":{"resources":[` + strings.Join(items, ",") + `]}}`))
	if n := strings.Count(got, "health=Degraded"); n != maxUnhealthyResourceLines {
		t.Fatalf("printed %d resource lines, want the cap %d", n, maxUnhealthyResourceLines)
	}
	if !strings.Contains(got, "… 25 more") {
		t.Fatalf("the cut must be counted:\n%s", got)
	}
}

func TestRenderArgoUnhealthyResourcesSaysNone(t *testing.T) {
	got := renderArgoUnhealthyResources([]byte(`{"status":{"resources":[{"kind":"Service","name":"s","health":{"status":"Healthy"}}]}}`))
	if !strings.Contains(got, "none —") {
		t.Fatalf("an all-Healthy list must say so, not print nothing:\n%s", got)
	}
}

const boutiquePodsJSON = `{"items": [
  {"metadata": {"name": "frontend-abc"}, "spec": {},
   "status": {"phase": "Pending", "conditions": [{"type": "PodScheduled", "status": "False", "reason": "Unschedulable", "message": "0/2 nodes are available: 2 Insufficient cpu. preemption: 0/2 nodes are available: 2 No preemption victims found for incoming pod."}]}},
  {"metadata": {"name": "cart-xyz"}, "spec": {"nodeName": "n1"},
   "status": {"phase": "Running", "conditions": [{"type": "PodScheduled", "status": "True"}, {"type": "Ready", "status": "False"}],
     "containerStatuses": [{"name": "server", "ready": false, "restartCount": 4, "state": {"waiting": {"reason": "CrashLoopBackOff", "message": "back-off 1m20s restarting failed container"}}, "lastState": {"terminated": {"reason": "OOMKilled", "exitCode": 137}}}]}},
  {"metadata": {"name": "ok-pod"}, "spec": {"nodeName": "n1"},
   "status": {"phase": "Running", "conditions": [{"type": "Ready", "status": "True"}]}},
  {"metadata": {"name": "done-job"}, "spec": {"nodeName": "n1"}, "status": {"phase": "Succeeded"}}
]}`

func TestParseNotReadyPods(t *testing.T) {
	lines, total, err := parseNotReadyPods([]byte(boutiquePodsJSON))
	if err != nil {
		t.Fatal(err)
	}
	if total != 4 || len(lines) != 2 {
		t.Fatalf("total=%d notReady=%d (%v); want 4 and 2 — Ready and Succeeded pods are not findings", total, len(lines), lines)
	}
	joined := strings.Join(lines, "\n")
	for _, want := range []string{
		"frontend-abc phase=Pending node=(none) — NOT SCHEDULED (Unschedulable): 0/2 nodes are available: 2 Insufficient cpu",
		"cart-xyz phase=Running node=n1; container server waiting CrashLoopBackOff: back-off 1m20s",
		"(restarts=4, last exit OOMKilled/137)",
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing %q\n--- got ---\n%s", want, joined)
		}
	}
}

func TestParseCPUMilli(t *testing.T) {
	for in, want := range map[string]int64{"250m": 250, "2": 2000, "0.5": 500, "3920m": 3920, " 1 ": 1000} {
		if got, err := parseCPUMilli(in); err != nil || got != want {
			t.Errorf("parseCPUMilli(%q) = %d, %v; want %d", in, got, err, want)
		}
	}
	for _, bad := range []string{"", "1Gi", "abc", "10x"} {
		if _, err := parseCPUMilli(bad); err == nil {
			t.Errorf("parseCPUMilli(%q) must be an error, not a silent zero", bad)
		}
	}
}

const twoNodesJSON = `{"items": [
  {"metadata": {"name": "n2", "labels": {"node.kubernetes.io/instance-type": "e2-standard-4"}}, "status": {"capacity": {"cpu": "4"}, "allocatable": {"cpu": "3920m", "memory": "13Gi"}}},
  {"metadata": {"name": "n1", "labels": {"node.kubernetes.io/instance-type": "e2-standard-4"}}, "status": {"capacity": {"cpu": "4"}, "allocatable": {"cpu": "3920m", "memory": "13Gi"}}}
]}`

const allPodsOnNodesJSON = `{"items": [
  {"metadata": {"name": "a"}, "spec": {"nodeName": "n1", "containers": [{"resources": {"requests": {"cpu": "1"}}}, {"resources": {"requests": {"cpu": "500m"}}}]}, "status": {"phase": "Running"}},
  {"metadata": {"name": "b"}, "spec": {"nodeName": "n1", "containers": [{"resources": {"requests": {"cpu": "2"}}}]}, "status": {"phase": "Succeeded"}},
  {"metadata": {"name": "c"}, "spec": {"nodeName": "n2", "containers": [{"resources": {"requests": {"cpu": "3800m"}}}, {"resources": {}}]}, "status": {"phase": "Running"}},
  {"metadata": {"name": "p"}, "spec": {"containers": [{"resources": {"requests": {"cpu": "100m"}}}]}, "status": {"phase": "Pending"}}
]}`

func TestParseNodeCPUPressure(t *testing.T) {
	lines, err := parseNodeCPUPressure([]byte(twoNodesJSON), []byte(allPodsOnNodesJSON), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 2 || !strings.HasPrefix(lines[0], "n1 ") {
		t.Fatalf("want two lines sorted by node name, got %v", lines)
	}
	// n1: the Succeeded pod's 2 cores hold nothing; the unscheduled pod is on no node.
	if !strings.Contains(lines[0], "n1 (e2-standard-4): capacity cpu=4, allocatable cpu=3920m memory=13Gi, requested cpu=1500m, FREE cpu=2420m") {
		t.Errorf("n1 line wrong: %s", lines[0])
	}
	if !strings.Contains(lines[1], "requested cpu=3800m, FREE cpu=120m") {
		t.Errorf("n2 line wrong: %s", lines[1])
	}
}

func TestParseNodeCPUPressureNeverReportsAnUnreadSumAsZero(t *testing.T) {
	lines, err := parseNodeCPUPressure([]byte(twoNodesJSON), nil, errors.New("context deadline exceeded"))
	if err != nil {
		t.Fatal(err)
	}
	for _, l := range lines {
		if !strings.Contains(l, "requested cpu UNKNOWN (pods unreadable: context deadline exceeded)") || strings.Contains(l, "FREE") {
			t.Errorf("an unread pod list must read as UNKNOWN, never as 0 requested / all free: %s", l)
		}
	}
	bad := `{"items":[{"metadata":{"name":"a"},"spec":{"nodeName":"n1","containers":[{"resources":{"requests":{"cpu":"lots"}}}]},"status":{"phase":"Running"}}]}`
	lines, _ = parseNodeCPUPressure([]byte(twoNodesJSON), []byte(bad), nil)
	if !strings.Contains(lines[0], "(1 request(s) unparseable and NOT counted)") {
		t.Errorf("an unparseable request must be counted as such: %s", lines[0])
	}
}

func TestRenderSchedulingDiagnosis(t *testing.T) {
	got := renderSchedulingDiagnosis("boutique-staging", []byte(boutiquePodsJSON), nil, []byte(twoNodesJSON), nil, []byte(allPodsOnNodesJSON), nil)
	for _, want := range []string{
		"pods in boutique-staging that are not Ready",
		"2 of 4 pod(s) not Ready:",
		"2 Insufficient cpu",
		"FREE cpu=120m",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q\n--- got ---\n%s", want, got)
		}
	}
	// Read failures are rendered as failures, never as "none".
	got = renderSchedulingDiagnosis("ns", nil, errors.New("exit status 1"), nil, errors.New("forbidden"), nil, nil)
	if !strings.Contains(got, "could not list pods (exit status 1)") || !strings.Contains(got, "could not list nodes (forbidden)") {
		t.Fatalf("read failures must be named:\n%s", got)
	}
	if strings.Contains(got, "none —") {
		t.Fatalf("a failed read rendered as an empty finding:\n%s", got)
	}
}
