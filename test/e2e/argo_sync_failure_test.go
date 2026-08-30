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
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
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

// The dump is BOUNDED, and the bound is not cosmetic: this runs inside the T2 context after the
// ArgoCD budget is spent, and a cancelled ctx kills the process before t.Cleanup tears the cluster
// down — leaking it to the sweeper. Twenty apps at five seconds is 100s against ~7m of headroom;
// twenty at twenty seconds would have been 400s, which is most of it.
//
// Asserted on the CAP rather than on wall-clock, because a timing test would be flaky and would not
// say what it means.
func TestDumpArgoSyncFailuresNamesWhatItSkipped(t *testing.T) {
	var losers []string
	for i := 0; i < 25; i++ {
		losers = append(losers, fmt.Sprintf("addon-%02d", i))
	}
	// No cluster: every read fails fast, which is the point — this exercises the loop's bound, not
	// kubectl. A context already past its deadline keeps it instant.
	ctx, cancel := context.WithTimeout(context.Background(), time.Nanosecond)
	defer cancel()
	out := dumpArgoSyncFailures(ctx, "/nonexistent/kubeconfig", losers)
	if !strings.Contains(out, "5 more failing Application(s) not asked") {
		t.Fatalf("the cap must name what it skipped:\n%s", out)
	}
	if strings.Contains(out, "addon-20") {
		t.Errorf("app 21 is past the cap and must not have been asked:\n%s", out)
	}
	if !strings.Contains(out, "addon-19") {
		t.Errorf("app 20 is within the cap and must have been asked:\n%s", out)
	}
	// And an empty loser set produces nothing at all, rather than a header with no body.
	if dumpArgoSyncFailures(ctx, "/nonexistent/kubeconfig", nil) != "" {
		t.Error("no losers means no section")
	}
}
