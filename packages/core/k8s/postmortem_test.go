// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package k8s

import (
	"errors"
	"strings"
	"testing"
)

func TestPodStallVerdict(t *testing.T) {
	tests := []struct {
		name    string
		phase   string
		ready   string
		waiting string
		want    string // substring; "" means the pod must NOT be reported at all
	}{
		{"running and ready is not a stall", "Running", "true true", "", ""},
		{"succeeded is not a stall", "Succeeded", "", "", ""},
		{"running but not ready blames readiness", "Running", "true false", "", "readiness probe is not passing"},
		{"running but not ready counts containers", "Running", "true false", "", "1/2 containers ready"},
		{"pending with no state is unschedulable", "Pending", "", "", "UNSCHEDULABLE"},
		{"image pull failure", "Pending", "false", "ImagePullBackOff", "image pull is FAILING"},
		{"err image pull failure", "Pending", "false", "ErrImagePull", "image pull is FAILING"},
		{"crash loop", "Running", "false", "CrashLoopBackOff", "starts then crashes"},
		{"missing secret", "Pending", "false", "CreateContainerConfigError", "Secret/ConfigMap"},
		{"still pulling is not yet a failure", "Pending", "false", "ContainerCreating", "may just need a longer wait"},
		{"unknown reason renders verbatim", "Unknown", "", "SomethingNew", "Unknown/SomethingNew"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := podStallVerdict(tc.phase, tc.ready, tc.waiting)
			if tc.want == "" {
				if got != "" {
					t.Fatalf("podStallVerdict = %q, want no verdict", got)
				}
				return
			}
			if !strings.Contains(got, tc.want) {
				t.Fatalf("podStallVerdict = %q, want it to contain %q", got, tc.want)
			}
		})
	}
}

// TestPodStallVerdictDoesNotMisdiagnose pins the distinctions that make the verdict worth printing
// at all: an unschedulable pod must not be reported as an image problem, and a pod that is merely
// pulling must not be reported as unschedulable. Those two want opposite fixes.
func TestPodStallVerdictDoesNotMisdiagnose(t *testing.T) {
	unschedulable := podStallVerdict("Pending", "", "")
	if strings.Contains(unschedulable, "image pull") {
		t.Fatalf("unschedulable pod misdiagnosed as an image problem: %q", unschedulable)
	}
	pulling := podStallVerdict("Pending", "false", "ContainerCreating")
	if strings.Contains(pulling, "UNSCHEDULABLE") {
		t.Fatalf("pulling pod misdiagnosed as unschedulable: %q", pulling)
	}
}

func TestPodStallVerdicts(t *testing.T) {
	t.Run("reports only the stalled pods", func(t *testing.T) {
		raw := strings.Join([]string{
			"argocd-redis-1\tRunning\ttrue \t ",
			"argocd-server-1\tPending\t\t",
			"argocd-repo-server-1\tRunning\ttrue false \t ",
		}, "\n")
		got := podStallVerdicts(raw)
		if strings.Contains(got, "argocd-redis-1") {
			t.Fatalf("healthy pod reported as stalled:\n%s", got)
		}
		for _, want := range []string{"argocd-server-1", "argocd-repo-server-1"} {
			if !strings.Contains(got, want) {
				t.Fatalf("stalled pod %q missing:\n%s", want, got)
			}
		}
	})

	t.Run("no pods at all returns empty so the section labels itself", func(t *testing.T) {
		if got := podStallVerdicts("   \n\n  "); got != "" {
			t.Fatalf("podStallVerdicts = %q, want empty", got)
		}
	})

	t.Run("every pod healthy says so rather than rendering blank", func(t *testing.T) {
		got := podStallVerdicts("argocd-redis-1\tRunning\ttrue \t \n")
		if !strings.Contains(got, "did NOT expire on a pod") {
			t.Fatalf("podStallVerdicts = %q, want the explicit all-healthy finding", got)
		}
	})
}

// TestParsePodStateToleratesShortLines pins that a pod with no containerStatuses — the
// never-scheduled pod, which is the single most interesting one in a stuck namespace — parses
// rather than being dropped as malformed.
func TestParsePodStateToleratesShortLines(t *testing.T) {
	name, phase, ready, waiting := parsePodState("argocd-server-1\tPending")
	if name != "argocd-server-1" || phase != "Pending" || ready != "" || waiting != "" {
		t.Fatalf("parsePodState = %q/%q/%q/%q", name, phase, ready, waiting)
	}
}

func TestAllReady(t *testing.T) {
	if !allReady("true true") {
		t.Fatal("allReady(\"true true\") = false")
	}
	if allReady("true false") {
		t.Fatal("allReady(\"true false\") = true")
	}
	// An empty list means the pod has no containerStatuses — never scheduled, definitively not
	// ready. Reading absence as readiness would drop the pods a stuck namespace is made of.
	if allReady("") {
		t.Fatal("allReady(\"\") = true, want false for a pod with no container statuses")
	}
}

func TestNamespaceEvidenceLabelsEmptySections(t *testing.T) {
	got := namespaceEvidence("argocd", "", "", "", "", "")
	if strings.Count(got, "(nothing returned)") != 5 {
		t.Fatalf("empty sections were dropped rather than labelled:\n%s", got)
	}
	if !strings.Contains(got, "argocd") {
		t.Fatalf("evidence does not name the namespace:\n%s", got)
	}
}

// TestNamespacePostMortemIssuesItsReads pins WHICH kubectl reads the post-mortem makes and which
// scope each one carries, plus the collectOut contract: a kubectl that ERRORS must report itself
// rather than render as "(nothing returned)", which reads as a healthy empty namespace.
//
// The scope split is the load-bearing part. Three reads are namespace-scoped, because a stalled
// workload is a fact about ITS namespace. Two are deliberately CLUSTER-scoped, because the pod
// ceiling that produced #2329 is a per-NODE property and every pod on the box counts against it —
// scoping those to the namespace would understate usage by the whole of kube-system and report a
// full node as having room, which inverts the diagnosis the section exists to give.
func TestNamespacePostMortemIssuesItsReads(t *testing.T) {
	resetK8sSeams(t)

	var commands []string
	executeCommandWithOutput = func(command, _ string, _ []string) (string, error) {
		commands = append(commands, command)
		return "", errors.New("kubectl: connection refused")
	}

	got := NamespacePostMortem("argocd")
	if len(commands) != 7 {
		t.Fatalf("commands = %#v, want exactly seven reads", commands)
	}

	// Anchored on "-n argocd" so a kube-system read carrying the same verb cannot satisfy
	// them by arriving first — the matcher, not the slice order, must decide.
	namespaced := []string{"-n argocd get pods -o wide", "-n argocd get pods -o jsonpath=", "-n argocd get events --sort-by=.lastTimestamp"}
	clusterWide := []string{"get nodes -o jsonpath=", "get pods -A -o jsonpath=", "-n kube-system get pods -o wide", "k8s-app=aws-node"}

	find := func(want string) string {
		for _, c := range commands {
			if strings.Contains(c, want) {
				return c
			}
		}
		t.Fatalf("no command contained %q: %#v", want, commands)
		return ""
	}
	for _, want := range namespaced {
		if c := find(want); !strings.Contains(c, "-n argocd") {
			t.Fatalf("read %q must be namespace-scoped: %q", want, c)
		}
	}
	for _, want := range clusterWide {
		if c := find(want); strings.Contains(c, "-n argocd") {
			t.Fatalf("read %q must be CLUSTER-scoped — namespace-scoping it undercounts the node's pods and inverts the capacity verdict: %q", want, c)
		}
	}
	if !strings.Contains(got, "command failed") {
		t.Fatalf("a broken kubectl rendered as an empty namespace:\n%s", got)
	}
}

// The verdict must DISCRIMINATE — that is the whole point of adding it. A section that says the
// same thing whether the node is full or empty would have left #2329 exactly as undiagnosable.
func TestNodePressureVerdictsSeparatesAFullNodeFromAnEmptySubnet(t *testing.T) {
	nodes := "ip-10-0-1-5\t35\t35\nip-10-0-2-9\t35\t35\n"

	// 35 pods placed on the first node, 3 on the second.
	var placement strings.Builder
	for i := 0; i < 35; i++ {
		placement.WriteString("ip-10-0-1-5\n")
	}
	for i := 0; i < 3; i++ {
		placement.WriteString("ip-10-0-2-9\n")
	}

	got := nodePressureVerdicts(nodes, placement.String())
	if !strings.Contains(got, "ip-10-0-1-5: AT THE POD CEILING") {
		t.Errorf("a node at 35/35 was not reported as full:\n%s", got)
	}
	if !strings.Contains(got, "ip-10-0-2-9: room to spare") {
		t.Errorf("a node at 3/35 was not reported as having room:\n%s", got)
	}
	// The two verdicts must not be the same sentence, or the section discriminates nothing.
	if strings.Contains(got, "ip-10-0-2-9: AT THE POD CEILING") {
		t.Errorf("an empty node was reported as full:\n%s", got)
	}
}

// Degenerate inputs must say so rather than render as a healthy cluster — the same rule
// namespaceEvidence applies to its empty sections.
func TestNodePressureVerdictsHandlesDegenerateInput(t *testing.T) {
	if got := nodePressureVerdicts("", ""); !strings.Contains(got, "no nodes returned") {
		t.Errorf("no nodes must be stated, not rendered as healthy: %q", got)
	}
	if got := nodePressureVerdicts("node-a\tnot-a-number\t35\n", ""); !strings.Contains(got, "unreadable") {
		t.Errorf("an unparseable allocatable count must be stated: %q", got)
	}
}

// TestNamespacePostMortemRejectsAnInvalidNamespace pins the fail-closed shell guard: the namespace
// interpolates into a `bash -c` string, so a non-RFC-1123 value must never reach it.
func TestNamespacePostMortemRejectsAnInvalidNamespace(t *testing.T) {
	resetK8sSeams(t)

	called := 0
	executeCommandWithOutput = func(string, string, []string) (string, error) {
		called++
		return "", nil
	}
	got := NamespacePostMortem("argocd; rm -rf /")
	if called != 0 {
		t.Fatalf("an invalid namespace reached the shell (%d commands)", called)
	}
	if !strings.Contains(got, "post-mortem skipped") {
		t.Fatalf("NamespacePostMortem = %q, want a skipped notice", got)
	}
}

// TestPodStatesJSONPathIsSingleQuoteSafe pins the assumption NamespacePostMortem relies on when it
// wraps the jsonpath in single quotes for `bash -c`.
func TestPodStatesJSONPathIsSingleQuoteSafe(t *testing.T) {
	if strings.Contains(podStatesJSONPath, "'") {
		t.Fatal("podStatesJSONPath contains a single quote — it would break the shell quoting")
	}
}

// The CNI tail is inlined into the runner log, which is itself captured into the proof bundle. An
// unbounded tail would blow that up — #1854 records an azure "highlights" file that turned out to
// be an entire 148 KB plan. Pin the cap and the tolerate-absent behaviour rather than trusting a
// comment to hold.
func TestCNILogCommandIsBoundedAndToleratesAbsentSelectors(t *testing.T) {
	if !strings.Contains(cniLogCommand, "--tail=50") {
		t.Error("the CNI log tail is unbounded — it lands in the runner log and the proof bundle")
	}
	if !strings.Contains(cniLogCommand, "|| true") {
		t.Error("a cluster without one of these CNIs must not error out the whole capture")
	}
	// All five clouds this repo provisions must have a selector, or the capture is silently
	// per-cloud and the gap is invisible from here.
	for _, sel := range []string{"aws-node", "cilium", "calico-node", "azure-cni", "gke-"} {
		if !strings.Contains(cniLogCommand, sel) {
			t.Errorf("no CNI selector covers %q", sel)
		}
	}
}
