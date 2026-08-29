// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

//go:build !e2e_t1 && !e2e_t2 && !e2e_b6

package e2e

import (
	"strings"
	"testing"
)

// The message is copied verbatim from azure/addons run 33255369578.
const realStallMessage = "waiting for completion of hook " +
	"rbac.authorization.k8s.io/ClusterRole/addon-kube-prometheus-stac-admission and 1 more hooks"

func TestParsePendingHookReadsTheRealMessage(t *testing.T) {
	ref, ok := parsePendingHook(realStallMessage)
	if !ok {
		t.Fatal("the message that motivated this file did not parse")
	}
	if ref.Group != "rbac.authorization.k8s.io" || ref.Kind != "ClusterRole" || ref.Name != "addon-kube-prometheus-stac-admission" {
		t.Fatalf("parsed %+v", ref)
	}
	// The `and 1 more hooks` tail must not be swallowed into the name.
	if strings.Contains(ref.Name, "and") {
		t.Errorf("the trailing prose was parsed as part of the name: %q", ref.Name)
	}
	if got := ref.Target(); got != "ClusterRole.rbac.authorization.k8s.io" {
		t.Errorf("Target() = %q — this is what kubectl is asked for", got)
	}
}

func TestParsePendingHookHandlesTheCoreGroupsEmptyPrefix(t *testing.T) {
	// gitops-engine renders a core-group resource with an EMPTY group, which leaves a leading
	// slash. Taking the kind and name from the END is what makes both shapes parse.
	ref, ok := parsePendingHook("waiting for completion of hook /ServiceAccount/certgen and 2 more hooks")
	if !ok {
		t.Fatal("a core-group hook did not parse")
	}
	if ref.Group != "" || ref.Kind != "ServiceAccount" || ref.Name != "certgen" {
		t.Fatalf("parsed %+v", ref)
	}
	if got := ref.Target(); got != "ServiceAccount" {
		t.Errorf("Target() = %q, want a bare kind for the core group", got)
	}
}

func TestParsePendingHookRefusesAMessageItDoesNotRecognise(t *testing.T) {
	for _, msg := range []string{
		"",
		"one or more objects failed to apply",
		"waiting for healthy state of apps/Deployment/grafana",
		"waiting for completion of hook justaname",
	} {
		if ref, ok := parsePendingHook(msg); ok {
			t.Errorf("%q was pattern-matched into %+v — a message we do not recognise must yield "+
				"nothing rather than a plausible wrong answer", msg, ref)
		}
	}
}

func TestParseHookLiveStateDedupesManagers(t *testing.T) {
	st, err := parseHookLiveState([]byte(`{"metadata":{"creationTimestamp":"2026-08-29T14:07:00Z",
	  "managedFields":[{"manager":"argocd-controller"},{"manager":"argocd-controller"},{"manager":"kubectl"}]}}`))
	if err != nil {
		t.Fatal(err)
	}
	if !st.Exists {
		t.Error("an object that parsed must be reported as existing")
	}
	if st.Created != "2026-08-29T14:07:00Z" {
		t.Errorf("creationTimestamp = %q", st.Created)
	}
	if len(st.Managers) != 2 || st.Managers[0] != "argocd-controller" || st.Managers[1] != "kubectl" {
		t.Errorf("managers = %v, want each writer once, in order", st.Managers)
	}
}

const stalledListJSON = `{"items":[
 {"metadata":{"name":"addon-kube-prometheus-stack"},"spec":{"destination":{"namespace":"monitoring"}},
  "status":{"operationState":{"message":"waiting for completion of hook rbac.authorization.k8s.io/ClusterRole/addon-kube-prometheus-stac-admission and 1 more hooks"}}},
 {"metadata":{"name":"addon-vault"},"spec":{"destination":{"namespace":"vault"}},
  "status":{"operationState":{"message":"successfully synced (all tasks run)"}}},
 {"metadata":{"name":"addon-loki"},"spec":{"destination":{"namespace":"logging"}},
  "status":{"operationState":{"message":"waiting for completion of hook batch/Job/loki-canary and 0 more hooks"}}}
]}`

func TestStalledHooksFromListPicksOnlyLosersThatAreWaiting(t *testing.T) {
	stalled, found, err := stalledHooksFromList([]byte(stalledListJSON), []string{"addon-kube-prometheus-stack", "addon-vault"})
	if err != nil {
		t.Fatal(err)
	}
	// Both losers were found in the list; only one is waiting on a hook. Those are separate
	// numbers, and collapsing them would make "not in the cluster" look like "nothing stalled".
	if found != 2 {
		t.Errorf("found = %d, want 2", found)
	}
	if len(stalled) != 1 {
		t.Fatalf("stalled = %+v, want just the one waiting on a hook", stalled)
	}
	if stalled[0].App != "addon-kube-prometheus-stack" || stalled[0].Namespace != "monitoring" {
		t.Errorf("wrong entry: %+v", stalled[0])
	}
	// addon-loki is stalled too, but it is not a loser this run — it must not be looked up.
	for _, s := range stalled {
		if s.App == "addon-loki" {
			t.Error("a healthy Application was looked up")
		}
	}
}

func TestStalledHooksFromListCountsLosersItCannotFind(t *testing.T) {
	_, found, err := stalledHooksFromList([]byte(stalledListJSON), []string{"addon-gone"})
	if err != nil {
		t.Fatal(err)
	}
	if found != 0 {
		t.Errorf("found = %d, want 0 — the caller reports that differently from 'nothing stalled'", found)
	}
}

func TestRenderPendingHookSaysWhichOfTheTwoFaultsItIs(t *testing.T) {
	ref := hookRef{Group: "rbac.authorization.k8s.io", Kind: "ClusterRole", Name: "x-admission"}

	absent := renderPendingHook("addon-x", ref, hookLiveState{Exists: false})
	if !strings.Contains(absent, "NOT IN THE CLUSTER") || !strings.Contains(absent, "on the way in") {
		t.Errorf("the absent verdict does not point at the apply path:\n%s", absent)
	}

	present := renderPendingHook("addon-x", ref, hookLiveState{Exists: true, Created: "t", Managers: []string{"argocd-controller"}})
	if !strings.Contains(present, "EXISTS") || !strings.Contains(present, "not observing it") {
		t.Errorf("the present verdict does not point at the watch path:\n%s", present)
	}
	// The two verdicts must not be confusable — they send the reader to opposite places.
	if strings.Contains(present, "NOT IN THE CLUSTER") {
		t.Errorf("the present verdict contains the absent one's words:\n%s", present)
	}

	unread := renderPendingHook("addon-x", ref, hookLiveState{ReadError: "timed out"})
	if !strings.Contains(unread, "says nothing about whether it exists") {
		t.Errorf("a failed lookup must not read as an absent object:\n%s", unread)
	}
}
