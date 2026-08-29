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

func TestRenderPendingHookSaysWhichOfTheThreeOutcomesItIs(t *testing.T) {
	ref := hookRef{Group: "rbac.authorization.k8s.io", Kind: "ClusterRole", Name: "x-admission"}
	app := stalledApp{App: "addon-x", Ref: ref}

	// 1. Absent AND unrecorded: the apply never landed.
	absent := renderPendingHook("addon-x", app, hookLiveState{Exists: false})
	if !strings.Contains(absent, "NOT IN THE CLUSTER") || !strings.Contains(absent, "on the way in") {
		t.Errorf("the never-applied verdict does not point at the apply path:\n%s", absent)
	}

	// 2. THE ONE THAT WAS WRONG. Absent but RECORDED: the apply landed and the object was removed,
	// which is the normal end state for a hook with `hook-delete-policy: hook-succeeded`. Reading
	// this as a failed apply sent azure/addons run 33266338989's reader to RBAC and quotas while
	// the Application's own sync result said `Synced … serverside-applied`.
	recorded := app
	// `Recorded` — not non-emptiness of SyncResult — is what says a result EXISTS, and `Status`/
	// `HookPhase` are what say whether it SUCCEEDED. Setting all three is what the production
	// extraction does; a fixture that sets only the text drifts from the path it stands for.
	recorded.Recorded = true
	recorded.Status, recorded.HookPhase = "Synced", "Running"
	recorded.SyncResult = "Synced Running clusterrole … serverside-applied"
	removed := renderPendingHook("addon-x", recorded, hookLiveState{Exists: false})
	if strings.Contains(removed, "NOT IN THE CLUSTER, and the sync recorded NO result") {
		t.Errorf("an applied-then-deleted hook was reported as a failed apply:\n%s", removed)
	}
	if !strings.Contains(removed, "serverside-applied") {
		t.Errorf("the recorded result is not quoted back:\n%s", removed)
	}
	if !strings.Contains(removed, "hook-delete-policy") {
		t.Errorf("the verdict does not name why absence is normal here:\n%s", removed)
	}
	if !strings.Contains(removed, "not at RBAC") {
		t.Errorf("the verdict does not steer the reader away from the wrong place:\n%s", removed)
	}

	// 3. Present: applied and unobserved.
	present := renderPendingHook("addon-x", app, hookLiveState{Exists: true, Created: "t", Managers: []string{"argocd-controller"}})
	if !strings.Contains(present, "EXISTS") || !strings.Contains(present, "not observing it") {
		t.Errorf("the present verdict does not point at the watch path:\n%s", present)
	}

	// The three must not be confusable — they send the reader to three different places.
	if strings.Contains(present, "NOT IN THE CLUSTER") || strings.Contains(removed, "EXISTS,") {
		t.Errorf("the verdicts overlap:\npresent=%s\nremoved=%s", present, removed)
	}

	unread := renderPendingHook("addon-x", app, hookLiveState{ReadError: "timed out"})
	if !strings.Contains(unread, "says nothing about whether it exists") {
		t.Errorf("a failed lookup must not read as an absent object:\n%s", unread)
	}
}

// The recorded result is matched on group+kind+name, so a same-named object of a DIFFERENT kind
// cannot lend its result to the hook and turn a genuine failed apply into "it was deleted".
func TestStalledHooksFromListMatchesTheRecordedResultExactly(t *testing.T) {
	const listJSON = `{"items":[
	 {"metadata":{"name":"addon-x"},"spec":{"destination":{"namespace":"monitoring"}},
	  "status":{"operationState":{
	    "message":"waiting for completion of hook rbac.authorization.k8s.io/ClusterRole/x-admission and 1 more hooks",
	    "syncResult":{"resources":[
	      {"group":"","kind":"ServiceAccount","name":"x-admission","status":"Synced","hookPhase":"Succeeded","message":"created"},
	      {"group":"rbac.authorization.k8s.io","kind":"ClusterRole","name":"x-admission","status":"Synced","hookPhase":"Running","message":"serverside-applied"}
	    ]}}}}
	]}`
	stalled, found, err := stalledHooksFromList([]byte(listJSON), []string{"addon-x"})
	if err != nil || found != 1 || len(stalled) != 1 {
		t.Fatalf("stalled=%+v found=%d err=%v", stalled, found, err)
	}
	got := stalled[0].SyncResult
	if !strings.Contains(got, "serverside-applied") {
		t.Errorf("SyncResult = %q, want the ClusterRole's own result", got)
	}
	if strings.Contains(got, "created") {
		t.Errorf("SyncResult = %q — it took the ServiceAccount's result, which is a different object", got)
	}
}

// And an Application that recorded nothing for the hook leaves it empty, so the renderer can say
// the apply never landed rather than inventing a reassurance.
func TestStalledHooksFromListLeavesTheResultEmptyWhenNoneWasRecorded(t *testing.T) {
	const listJSON = `{"items":[
	 {"metadata":{"name":"addon-x"},"spec":{"destination":{"namespace":"monitoring"}},
	  "status":{"operationState":{
	    "message":"waiting for completion of hook rbac.authorization.k8s.io/ClusterRole/x-admission and 1 more hooks",
	    "syncResult":{"resources":[]}}}}
	]}`
	stalled, _, err := stalledHooksFromList([]byte(listJSON), []string{"addon-x"})
	if err != nil {
		t.Fatal(err)
	}
	if len(stalled) != 1 || stalled[0].SyncResult != "" {
		t.Fatalf("SyncResult = %q, want empty", stalled[0].SyncResult)
	}
}

// A RECORDED FAILURE MUST NOT READ AS A LANDING.
//
// ArgoCD writes a ResourceResult for a failed apply exactly as it does for a successful one, so
// the object is absent AND recorded. Branching on the mere presence of a record therefore printed
// "the apply landed … not at RBAC" over a message whose own text says `is forbidden` — steering
// the reader away from RBAC in precisely the case where RBAC is the answer.
func TestPendingHookVerdictSeparatesARecordedFailureFromALanding(t *testing.T) {
	forbidden := stalledApp{
		App:        "addon-keda",
		Ref:        hookRef{Group: "rbac.authorization.k8s.io", Kind: "ClusterRole", Name: "keda-operator"},
		Recorded:   true,
		Status:     "SyncFailed",
		HookPhase:  "Failed",
		SyncResult: `SyncFailed Failed clusterroles.rbac.authorization.k8s.io "keda-operator" is forbidden`,
	}
	if !forbidden.recordedFailure() {
		t.Fatal("a SyncFailed/Failed result is not being recognised as a failure")
	}
	out := renderPendingHook(forbidden.App, forbidden, hookLiveState{})
	if strings.Contains(out, "the apply landed") {
		t.Errorf("a recorded FAILURE renders as a landing:\n%s", out)
	}
	if strings.Contains(out, "not at RBAC") {
		t.Errorf("a recorded FAILURE steers the reader away from RBAC:\n%s", out)
	}
	if !strings.Contains(out, "REFUSED") {
		t.Errorf("the failure verdict does not say the apply was refused:\n%s", out)
	}

	// The success case must keep its verdict — the fix must not turn every absence into a failure.
	succeeded := stalledApp{
		App:        "addon-vault",
		Ref:        hookRef{Kind: "Job", Name: "vault-init"},
		Recorded:   true,
		Status:     "Synced",
		HookPhase:  "Succeeded",
		SyncResult: "Synced Succeeded",
	}
	if succeeded.recordedFailure() {
		t.Error("a Synced/Succeeded result is being read as a failure")
	}
	if out := renderPendingHook(succeeded.App, succeeded, hookLiveState{}); !strings.Contains(out, "the apply landed") {
		t.Errorf("a recorded SUCCESS lost its landing verdict:\n%s", out)
	}
}

// A result with no ResultCode, no phase and no message trims to "" — which non-emptiness reads as
// "the sync recorded NO result for it". That is nothing-found reported as nothing-wrong, the
// conflation the rest of this file exists to avoid.
func TestPendingHookAnEmptyResultIsStillARecord(t *testing.T) {
	empty := stalledApp{App: "addon-x", Ref: hookRef{Kind: "Job", Name: "j"}, Recorded: true}
	out := renderPendingHook(empty.App, empty, hookLiveState{})
	if strings.Contains(out, "recorded NO result") {
		t.Errorf("a recorded-but-empty result is reported as no record at all:\n%s", out)
	}
}
