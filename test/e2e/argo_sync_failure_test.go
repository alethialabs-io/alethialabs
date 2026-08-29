// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure halves of the sync-failure dump — no cluster, so they run on every PR.
//
// The shape these parse is the one thing that can silently stop matching, and the cost of finding
// that out on a real run is a paid cloud run that reports nothing. So the field paths are pinned
// here against fixtures, and the "we read nothing" branch is asserted to read differently from the
// "there was nothing to read" one.
package e2e

import (
	"errors"
	"strings"
	"testing"
)

func TestParseArgoAppFailureReadsTheOperationState(t *testing.T) {
	const appJSON = `{"status":{
		"operationState":{
			"phase":"Failed",
			"message":"one or more objects failed to apply",
			"syncResult":{"resources":[
				{"kind":"ConfigMap","namespace":"monitoring","name":"ok-one","status":"Synced","message":"configmap created"},
				{"kind":"CustomResourceDefinition","namespace":"","name":"prometheuses.monitoring.coreos.com","status":"SyncFailed","message":"the server responded with 413 Request Entity Too Large"}
			]}
		},
		"conditions":[
			{"type":"Info","message":"nothing to see"},
			{"type":"ComparisonError","message":"rpc error: code = Unknown"}
		]}}`
	f, err := parseArgoAppFailure([]byte(appJSON))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if f.Phase != "Failed" || !strings.Contains(f.Message, "failed to apply") {
		t.Fatalf("phase/message not read: %+v", f)
	}
	// ONLY the resource that did not go in. kube-prometheus-stack renders over a hundred, and
	// printing the ones that synced buries the handful that did not.
	if len(f.SyncErrors) != 1 || !strings.Contains(f.SyncErrors[0], "prometheuses.monitoring.coreos.com") {
		t.Fatalf("want exactly the failed resource, got %v", f.SyncErrors)
	}
	if !strings.Contains(f.SyncErrors[0], "(cluster)") {
		t.Errorf("a cluster-scoped resource must not render with an empty namespace: %v", f.SyncErrors)
	}
	if len(f.Conditions) != 1 || !strings.Contains(f.Conditions[0], "ComparisonError") {
		t.Fatalf("Info conditions are not failures; want only ComparisonError, got %v", f.Conditions)
	}
}

// A sync that was NEVER ATTEMPTED has no operationState at all — which is the azure
// kube-prometheus-stack shape (`Missing/OutOfSync`, every resource absent). That must not render as
// "nothing wrong": it is a finding, and it points somewhere else.
func TestRenderArgoAppFailureDistinguishesNeverSyncedFromUnreadable(t *testing.T) {
	never := renderArgoAppFailure("addon-kube-prometheus-stack", argoAppFailure{}, nil)
	if !strings.Contains(never, "never been synced at all") {
		t.Fatalf("an empty account must say so explicitly:\n%s", never)
	}
	if !strings.Contains(never, "app-of-apps") {
		t.Errorf("it must point at what should have synced it, not at the chart:\n%s", never)
	}

	unread := renderArgoAppFailure("addon-keda", argoAppFailure{}, errors.New("exit status 1"))
	if !strings.Contains(unread, "could not be read") || !strings.Contains(unread, "says nothing") {
		t.Fatalf("an unreadable Application must not read like an empty one:\n%s", unread)
	}
	if strings.Contains(unread, "never been synced") {
		t.Fatal("the two branches must not collapse — that is the whole point of having both")
	}
}

// Garbage must fail loudly rather than come back as an empty account, which would render as the
// reassuring "never synced" branch above.
func TestParseArgoAppFailureFailsLoudlyOnGarbage(t *testing.T) {
	if _, err := parseArgoAppFailure([]byte("not json")); err == nil {
		t.Fatal("unparseable input reported success — it would print as 'never been synced at all'")
	}
}

// The per-resource list is capped, and the cap says how many it dropped.
func TestRenderArgoAppFailureCapsTheResourceList(t *testing.T) {
	f := argoAppFailure{Phase: "Failed"}
	for i := 0; i < 20; i++ {
		f.SyncErrors = append(f.SyncErrors, "ConfigMap/x in ns: SyncFailed boom")
	}
	out := renderArgoAppFailure("addon-x", f, nil)
	if !strings.Contains(out, "8 more resource(s) with a sync error") {
		t.Fatalf("a truncated list must name what it dropped:\n%s", out)
	}
}
