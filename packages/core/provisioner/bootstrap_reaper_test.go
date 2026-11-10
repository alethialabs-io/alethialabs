// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// reapCall is one kubectl invocation the fake recorded.
type reapCall struct {
	stdin string
	args  []string
}

// fakeReapKubectl stands in for the cluster: respond answers each call (by its joined args), and every
// call is recorded. It restores the real seam when the test ends.
func fakeReapKubectl(t *testing.T, respond func(args string) (string, error)) *[]reapCall {
	t.Helper()
	prevNow := reapNow
	reapNow = func() time.Time { return runnerNow }
	t.Cleanup(func() { reapNow = prevNow })
	var calls []reapCall
	prev := bootstrapReapKubectl
	bootstrapReapKubectl = func(_ context.Context, stdin string, args ...string) (string, error) {
		calls = append(calls, reapCall{stdin: stdin, args: args})
		return respond(strings.Join(args, " "))
	}
	t.Cleanup(func() { bootstrapReapKubectl = prev })
	return &calls
}

// The literal call shapes. The selector, hook annotation, delete policy and names are written out
// here rather than taken from the manifests constants, so a change to those constants fails here.
const (
	reapAppGet  = "get applications.argoproj.io apps -n argocd -o json --show-managed-fields"
	reapJobList = "get jobs.batch -n default -o json"
	reapESList  = "get externalsecrets.external-secrets.io -n default -l alethia.io/bootstrap-only=true -o json"
	reapSAList  = "get serviceaccounts -n default -l alethia.io/bootstrap-only=true -o json"

	esName       = "bootstrap-database-orders-admin"
	saName       = "alethia-db-bootstrap"
	esAPIVersion = "external-secrets.io/v1beta1"
	adminPolicy  = "BeforeHookCreation,HookSucceeded,HookFailed"

	// lastWrite is the newest API-server write time in the default Application fixture; the cutoff is
	// one minute before it.
	lastWrite = "2026-11-04T10:00:00Z"
)

// runnerNow is the runner's clock in every test: ten minutes after the default fixture's newest write.
var runnerNow = time.Date(2026, 11, 4, 10, 10, 0, 0, time.UTC)

// appJSON renders an apps Application. phase "" renders no operationState; writes are its
// managedFields times (the creationTimestamp is fixed and older than all of them).
func appJSON(phase string, requested bool, writes ...string) string {
	var mf []map[string]any
	for _, w := range writes {
		mf = append(mf, map[string]any{"manager": "argocd-application-controller", "operation": "Update", "time": w})
	}
	app := map[string]any{"metadata": map[string]any{"creationTimestamp": "2026-11-01T00:00:00Z", "managedFields": mf}}
	if requested {
		app["operation"] = map[string]any{"sync": map[string]any{}}
	}
	if phase != "" {
		// finishedAt is the controller's clock and deliberately far in the future here: the cutoff
		// must not be taken from it.
		app["status"] = map[string]any{"operationState": map[string]any{"phase": phase, "finishedAt": "2099-01-01T00:00:00Z"}}
	}
	b, _ := json.Marshal(app)
	return string(b)
}

// hook renders one listed bootstrap hook with the rendered identity; mutate edits it before use.
func hook(apiVersion, name, uid, created string, finalizers []string, mutate func(meta, annotations map[string]any)) map[string]any {
	ann := map[string]any{
		"argocd.argoproj.io/hook":               "PreSync",
		"argocd.argoproj.io/hook-delete-policy": adminPolicy,
		"argocd.argoproj.io/sync-wave":          "-1",
	}
	meta := map[string]any{
		"name": name, "namespace": "default", "uid": uid,
		"creationTimestamp": created, "finalizers": finalizers, "annotations": ann,
	}
	if mutate != nil {
		mutate(meta, ann)
	}
	return map[string]any{"apiVersion": apiVersion, "metadata": meta}
}

// job renders one listed Job.
func job(name, hookAnn string, active int, conditions ...string) map[string]any {
	var conds []map[string]any
	for _, c := range conditions {
		conds = append(conds, map[string]any{"type": c, "status": "True"})
	}
	ann := map[string]any{}
	if hookAnn != "" {
		ann["argocd.argoproj.io/hook"] = hookAnn
	}
	return map[string]any{
		"metadata": map[string]any{"name": name, "namespace": "default", "annotations": ann},
		"status":   map[string]any{"active": active, "conditions": conds},
	}
}

// listJSON renders a kubectl list of items.
func listJSON(items ...map[string]any) string {
	b, _ := json.Marshal(map[string]any{"items": items})
	return string(b)
}

// cluster is a scripted fake: the Application, the Jobs and the two hook lists, plus optional
// overrides for writes.
type cluster struct {
	app, jobs, es, sa string
	onWrite           func(args string) (string, error)
}

// respond answers one call from the scripted cluster.
func (c cluster) respond(t *testing.T) func(args string) (string, error) {
	return func(args string) (string, error) {
		switch args {
		case reapAppGet:
			return c.app, nil
		case reapJobList:
			if c.jobs == "" {
				return listJSON(), nil
			}
			return c.jobs, nil
		case reapESList:
			if c.es == "" {
				return listJSON(), nil
			}
			return c.es, nil
		case reapSAList:
			if c.sa == "" {
				return listJSON(), nil
			}
			return c.sa, nil
		}
		if strings.HasPrefix(args, "patch ") || strings.HasPrefix(args, "delete ") {
			if c.onWrite != nil {
				return c.onWrite(args)
			}
			return "", nil
		}
		t.Errorf("unexpected kubectl call: %s", args)
		return "", nil
	}
}

// writesOf returns the patch and delete calls among calls.
func writesOf(calls []reapCall) []reapCall {
	var out []reapCall
	for _, c := range calls {
		if c.args[0] == "patch" || c.args[0] == "delete" {
			out = append(out, c)
		}
	}
	return out
}

func uid(n string) string { return "0a1b2c3d-0000-4000-8000-" + n }

func TestStrandedHookCutoff(t *testing.T) {
	for _, tc := range []struct {
		name   string
		raw    string
		ok     bool
		cutoff string
	}{
		{"succeeded", appJSON("Succeeded", false, "2026-11-04T09:00:00Z", lastWrite), true, "2026-11-04T09:59:00Z"},
		{"failed (a terminated operation ends here)", appJSON("Failed", false, lastWrite), true, "2026-11-04T09:59:00Z"},
		{"error", appJSON("Error", false, lastWrite), true, "2026-11-04T09:59:00Z"},
		{"the NEWEST write time wins, whatever its order", appJSON("Failed", false, lastWrite, "2026-11-04T08:00:00Z"), true, "2026-11-04T09:59:00Z"},
		{"never operated", appJSON("", false, "2026-11-02T00:00:00Z"), true, "2026-11-01T23:59:00Z"},
		{"running", appJSON("Running", false, lastWrite), false, ""},
		{"terminating", appJSON("Terminating", false, lastWrite), false, ""},
		{"terminal but another operation is requested", appJSON("Failed", true, lastWrite), false, ""},
		{"never operated but one is requested", appJSON("", true, lastWrite), false, ""},
		{"no managedFields (read without them)", appJSON("Failed", false), false, ""},
		{"an unreadable write time", appJSON("Failed", false, lastWrite, "yesterday"), false, ""},
		{"unreadable", "{not json", false, ""},
		// A write time later than the runner's clock plus the margin would lift the cutoff past the
		// read, so it refuses; one inside the margin is skew and is accepted.
		{"a write time beyond the runner clock plus the margin", appJSON("Failed", false, lastWrite, "2026-11-04T10:11:01Z"), false, ""},
		{"a write time within the margin of the runner clock", appJSON("Failed", false, "2026-11-04T10:10:30Z"), true, "2026-11-04T10:09:30Z"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cutoff, ok, reason := strandedHookCutoff([]byte(tc.raw), runnerNow)
			if ok != tc.ok {
				t.Fatalf("ok = %v (reason %q), want %v", ok, reason, tc.ok)
			}
			if !ok {
				if reason == "" {
					t.Error("a refusal must say why")
				}
				return
			}
			if want, _ := time.Parse(time.RFC3339, tc.cutoff); !cutoff.Equal(want) {
				t.Errorf("cutoff = %v, want %v", cutoff, want)
			}
		})
	}
}

// TestReapStrandedBootstrapHooks_RemovesOnlyWhatPredatesTheCutoff is the end-to-end decision after a
// terminated operation: the hooks it left are deleted, UID-guarded and Foreground, with ArgoCD's hook
// finalizer released first where present; a hook created inside the margin is left alone.
func TestReapStrandedBootstrapHooks_RemovesOnlyWhatPredatesTheCutoff(t *testing.T) {
	c := cluster{
		app: appJSON("Failed", false, lastWrite),
		es: listJSON(
			hook(esAPIVersion, esName, uid("00000000e501"), "2026-11-04T09:50:00Z",
				[]string{"foregroundDeletion", "argocd.argoproj.io/hook-finalizer"}, nil),
			// Created 30s before the newest write: inside the margin.
			hook(esAPIVersion, "bootstrap-database-billing-admin", uid("00000000e502"), "2026-11-04T09:59:30Z", nil, nil),
			// Created exactly at the cutoff second: not strictly before it.
			hook(esAPIVersion, "bootstrap-database-billing2-admin", uid("00000000e503"), "2026-11-04T09:59:00Z", nil, nil),
		),
		sa: listJSON(hook("v1", saName, uid("00000000a501"), "2026-11-04T09:58:59Z", nil, nil)),
	}
	calls := fakeReapKubectl(t, c.respond(t))

	if got := reapStrandedBootstrapHooks(context.Background(), "apps", "default", io.Discard, io.Discard); got != 2 {
		t.Fatalf("requested %d deletions, want 2 (the old ExternalSecret and the old ServiceAccount)", got)
	}
	want := []reapCall{
		{args: []string{"patch", "externalsecrets.external-secrets.io", esName, "-n", "default", "--type=json", "-p",
			`[{"op":"test","path":"/metadata/uid","value":"` + uid("00000000e501") + `"},{"op":"test","path":"/metadata/finalizers/1","value":"argocd.argoproj.io/hook-finalizer"},{"op":"remove","path":"/metadata/finalizers/1"}]`}},
		{stdin: `{"kind":"DeleteOptions","apiVersion":"v1","propagationPolicy":"Foreground","preconditions":{"uid":"` + uid("00000000e501") + `"}}`,
			args: []string{"delete", "--raw", "/apis/external-secrets.io/v1beta1/namespaces/default/externalsecrets/" + esName, "-f", "-"}},
		{stdin: `{"kind":"DeleteOptions","apiVersion":"v1","propagationPolicy":"Foreground","preconditions":{"uid":"` + uid("00000000a501") + `"}}`,
			args: []string{"delete", "--raw", "/api/v1/namespaces/default/serviceaccounts/" + saName, "-f", "-"}},
	}
	writes := writesOf(*calls)
	if len(writes) != len(want) {
		t.Fatalf("got %d writes, want %d:\n%+v", len(writes), len(want), writes)
	}
	for i := range want {
		if writes[i].stdin != want[i].stdin || strings.Join(writes[i].args, " ") != strings.Join(want[i].args, " ") {
			t.Errorf("write %d:\n got  %+v\n want %+v", i, writes[i], want[i])
		}
	}
	for _, w := range writes {
		if strings.Contains(strings.Join(w.args, " ")+w.stdin, "billing") || strings.Contains(w.stdin, "00000000e50") && !strings.Contains(w.stdin, "00000000e501") {
			t.Errorf("touched a hook created inside the margin or at the cutoff: %+v", w)
		}
	}
}

// TestReapStrandedBootstrapHooks_TerminatedHooksWithoutFinalizer: ArgoCD's terminate strips the hook
// finalizer from every live hook, so the usual stranded hook carries none. It is deleted with no patch.
func TestReapStrandedBootstrapHooks_TerminatedHooksWithoutFinalizer(t *testing.T) {
	c := cluster{
		app: appJSON("Failed", false, lastWrite),
		es:  listJSON(hook(esAPIVersion, esName, uid("00000000e501"), "2026-11-04T09:00:00Z", nil, nil)),
	}
	calls := fakeReapKubectl(t, c.respond(t))
	if got := reapStrandedBootstrapHooks(context.Background(), "apps", "default", io.Discard, io.Discard); got != 1 {
		t.Fatalf("requested %d deletions, want 1", got)
	}
	writes := writesOf(*calls)
	if len(writes) != 1 || writes[0].args[0] != "delete" {
		t.Errorf("want exactly one delete and no patch, got %+v", writes)
	}
}

// TestReapStrandedBootstrapHooks_NeverSyncedApplication: an Application with no operation record (it
// was recreated) still reconciles, against the newest of its own write times.
func TestReapStrandedBootstrapHooks_NeverSyncedApplication(t *testing.T) {
	c := cluster{
		app: appJSON("", false, "2026-11-02T00:00:00Z"),
		sa: listJSON(
			hook("v1", saName, uid("00000000a501"), "2026-10-30T00:00:00Z", nil, nil), // a previous Application's
		),
		es: listJSON(
			hook(esAPIVersion, esName, uid("00000000e501"), "2026-11-03T00:00:00Z", nil, nil), // after the cutoff
		),
	}
	calls := fakeReapKubectl(t, c.respond(t))
	if got := reapStrandedBootstrapHooks(context.Background(), "apps", "default", io.Discard, io.Discard); got != 1 {
		t.Fatalf("requested %d deletions, want 1 (the ServiceAccount)", got)
	}
	writes := writesOf(*calls)
	if len(writes) != 1 || !strings.Contains(strings.Join(writes[0].args, " "), "/serviceaccounts/"+saName) {
		t.Errorf("want only the ServiceAccount deleted, got %+v", writes)
	}
}

// TestReapStrandedBootstrapHooks_LiveOperationReapsNothing: while ArgoCD reports an operation that is
// not terminal, the reconcile does not even list the hooks.
func TestReapStrandedBootstrapHooks_LiveOperationReapsNothing(t *testing.T) {
	for _, phase := range []string{"Running", "Terminating"} {
		t.Run(phase, func(t *testing.T) {
			calls := fakeReapKubectl(t, func(args string) (string, error) {
				if args == reapAppGet {
					return appJSON(phase, false, lastWrite), nil
				}
				t.Errorf("unexpected call while the operation is %s: %s", phase, args)
				return "", nil
			})
			if got := reapStrandedBootstrapHooks(context.Background(), "apps", "default", io.Discard, io.Discard); got != 0 {
				t.Errorf("requested %d deletions, want 0", got)
			}
			if len(*calls) != 1 {
				t.Errorf("%d calls, want only the Application read", len(*calls))
			}
		})
	}
}

// TestReapStrandedBootstrapHooks_ActiveBootstrapJobReapsNothing: an operation can end in Error with the
// PreSync Job still running, so an active bootstrap Job stops the reconcile before any hook is listed.
func TestReapStrandedBootstrapHooks_ActiveBootstrapJobReapsNothing(t *testing.T) {
	for _, tc := range []struct {
		name string
		jobs string
	}{
		{"active pods", listJSON(job("bootstrap-database-orders", "PreSync", 1))},
		{"no finished condition yet", listJSON(job("bootstrap-database-orders", "PreSync", 0))},
		{"active despite a stale condition", listJSON(job("bootstrap-database-orders", "PreSync", 1, "Failed"))},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := cluster{app: appJSON("Error", false, lastWrite), jobs: tc.jobs}
			calls := fakeReapKubectl(t, func(args string) (string, error) {
				if args == reapESList || args == reapSAList {
					t.Errorf("listed hooks while a bootstrap Job is active: %s", args)
				}
				return c.respond(t)(args)
			})
			if got := reapStrandedBootstrapHooks(context.Background(), "apps", "default", io.Discard, io.Discard); got != 0 {
				t.Errorf("requested %d deletions, want 0", got)
			}
			if len(writesOf(*calls)) != 0 {
				t.Errorf("wrote while a bootstrap Job is active: %+v", writesOf(*calls))
			}
		})
	}
}

// TestActiveBootstrapJob pins which Jobs count: only a PreSync hook with the bootstrap name prefix,
// and only while it has active pods or no Complete/Failed condition.
func TestActiveBootstrapJob(t *testing.T) {
	parse := func(raw string) []reapObject {
		var l struct {
			Items []reapObject `json:"items"`
		}
		if err := json.Unmarshal([]byte(raw), &l); err != nil {
			t.Fatal(err)
		}
		return l.Items
	}
	for _, tc := range []struct {
		name string
		jobs string
		want string
	}{
		{"complete", listJSON(job("bootstrap-database-orders", "PreSync", 0, "Complete")), ""},
		{"failed (kept for its logs)", listJSON(job("bootstrap-database-orders", "PreSync", 0, "Failed")), ""},
		{"running", listJSON(job("bootstrap-database-orders", "PreSync", 1)), "bootstrap-database-orders"},
		{"not a hook", listJSON(job("bootstrap-database-orders", "", 1)), ""},
		{"another name", listJSON(job("nightly-report", "PreSync", 1)), ""},
		{"none", listJSON(), ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := activeBootstrapJob(parse(tc.jobs)); got != tc.want {
				t.Errorf("activeBootstrapJob = %q, want %q", got, tc.want)
			}
		})
	}
}

// TestReapStrandedBootstrapHooks_FailsSafe: an unreadable Application, an unreadable Job list and a
// failed finalizer release each reap nothing.
func TestReapStrandedBootstrapHooks_FailsSafe(t *testing.T) {
	t.Run("unreadable Application", func(t *testing.T) {
		calls := fakeReapKubectl(t, func(string) (string, error) { return "", errors.New("connection refused") })
		if got := reapStrandedBootstrapHooks(context.Background(), "apps", "default", io.Discard, io.Discard); got != 0 {
			t.Errorf("requested %d deletions, want 0", got)
		}
		if len(*calls) != 1 {
			t.Errorf("%d calls, want only the failed Application read", len(*calls))
		}
	})

	for _, tc := range []struct {
		name string
		resp func() (string, error)
	}{
		{"Job list fails", func() (string, error) { return "", errors.New("forbidden") }},
		{"Job list unparseable", func() (string, error) { return "{not json", nil }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := fakeReapKubectl(t, func(args string) (string, error) {
				switch args {
				case reapAppGet:
					return appJSON("Failed", false, lastWrite), nil
				case reapJobList:
					return tc.resp()
				}
				t.Errorf("unexpected call after the Job read failed: %s", args)
				return "", nil
			})
			if got := reapStrandedBootstrapHooks(context.Background(), "apps", "default", io.Discard, io.Discard); got != 0 {
				t.Errorf("requested %d deletions, want 0", got)
			}
			if len(*calls) != 2 {
				t.Errorf("%d calls, want the Application and Job reads only", len(*calls))
			}
		})
	}

	t.Run("finalizer release fails, so no delete", func(t *testing.T) {
		c := cluster{
			app: appJSON("Failed", false, lastWrite),
			es: listJSON(hook(esAPIVersion, esName, uid("000000000001"), "2026-11-04T09:00:00Z",
				[]string{"argocd.argoproj.io/hook-finalizer"}, nil)),
			onWrite: func(args string) (string, error) {
				if strings.HasPrefix(args, "patch ") {
					return "", errors.New("the uid test failed")
				}
				return "", nil
			},
		}
		calls := fakeReapKubectl(t, c.respond(t))
		if got := reapStrandedBootstrapHooks(context.Background(), "apps", "default", io.Discard, io.Discard); got != 0 {
			t.Errorf("requested %d deletions, want 0", got)
		}
		for _, w := range writesOf(*calls) {
			if w.args[0] == "delete" {
				t.Errorf("deleted after the finalizer release failed: %+v", w)
			}
		}
	})
}

// TestReapStrandedBootstrapHooks_OnlyARenderedBootstrapHook is defence in depth: an object is reaped
// only if it is exactly the rendered bootstrap hook. Each case breaks ONE part of the identity of an
// otherwise valid hook, and a valid control object sits beside it, so a refusal cannot come from
// anything but that part.
func TestReapStrandedBootstrapHooks_OnlyARenderedBootstrapHook(t *testing.T) {
	const old = "2026-11-04T09:00:00Z"
	for _, tc := range []struct {
		name   string
		kindSA bool
		mutate func(meta, ann map[string]any)
		apiV   string
	}{
		{"no hook annotation", false, func(_, a map[string]any) { delete(a, "argocd.argoproj.io/hook") }, ""},
		{"another hook phase", false, func(_, a map[string]any) { a["argocd.argoproj.io/hook"] = "PostSync" }, ""},
		{"no delete policy", false, func(_, a map[string]any) { delete(a, "argocd.argoproj.io/hook-delete-policy") }, ""},
		{"another delete policy", false, func(_, a map[string]any) { a["argocd.argoproj.io/hook-delete-policy"] = "BeforeHookCreation" }, ""},
		{"ExternalSecret without the name prefix", false, func(m, _ map[string]any) { m["name"] = "database-orders-admin" }, ""},
		{"ExternalSecret without the name suffix", false, func(m, _ map[string]any) { m["name"] = "bootstrap-database-orders" }, ""},
		{"ExternalSecret that is only prefix and suffix", false, func(m, _ map[string]any) { m["name"] = "bootstrap--admin" }, ""},
		{"ServiceAccount with another name", true, func(m, _ map[string]any) { m["name"] = "alethia-app" }, ""},
		{"another namespace", true, func(m, _ map[string]any) { m["namespace"] = "kube-system" }, ""},
		{"not a DNS-1123 name", false, func(m, _ map[string]any) { m["name"] = "bootstrap-Bad Name-admin" }, ""},
		{"not a UID", false, func(m, _ map[string]any) { m["uid"] = "uid/../3" }, ""},
		{"wrong apiVersion for the kind", false, nil, "v1"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			bad := func() map[string]any {
				if tc.kindSA {
					return hook("v1", saName, uid("000000000002"), old, nil, tc.mutate)
				}
				apiV := esAPIVersion
				if tc.apiV != "" {
					apiV = tc.apiV
				}
				return hook(apiV, esName, uid("000000000002"), old, nil, tc.mutate)
			}()
			control := hook(esAPIVersion, "bootstrap-database-control-admin", uid("000000000005"), old, nil, nil)
			c := cluster{app: appJSON("Succeeded", false, lastWrite), es: listJSON(control)}
			if tc.kindSA {
				c.sa = listJSON(bad)
			} else {
				c.es = listJSON(bad, control)
			}
			calls := fakeReapKubectl(t, c.respond(t))
			if got := reapStrandedBootstrapHooks(context.Background(), "apps", "default", io.Discard, io.Discard); got != 1 {
				t.Errorf("requested %d deletions, want 1 (the control object only)", got)
			}
			for _, w := range writesOf(*calls) {
				if !strings.Contains(strings.Join(w.args, " "), "/externalsecrets/bootstrap-database-control-admin") {
					t.Errorf("wrote to an object that is not a rendered bootstrap hook: %+v", w)
				}
			}
		})
	}
}

// TestReapStrandedBootstrapHooks_ListFailuresReapNothing: a kind whose list fails (no External Secrets
// Operator CRD on the cluster) or returns an unparseable document is skipped, and the other kind is
// still reconciled.
func TestReapStrandedBootstrapHooks_ListFailuresReapNothing(t *testing.T) {
	for _, tc := range []struct {
		name   string
		esList func() (string, error)
	}{
		{"list fails", func() (string, error) { return "", errors.New("the server doesn't have a resource type") }},
		{"list unparseable", func() (string, error) { return "{not json", nil }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := cluster{
				app: appJSON("Failed", false, lastWrite),
				sa:  listJSON(hook("v1", saName, uid("00000000a501"), "2026-11-04T09:00:00Z", nil, nil)),
			}
			fakeReapKubectl(t, func(args string) (string, error) {
				if args == reapESList {
					return tc.esList()
				}
				return c.respond(t)(args)
			})
			if got := reapStrandedBootstrapHooks(context.Background(), "apps", "default", io.Discard, io.Discard); got != 1 {
				t.Errorf("requested %d deletions, want 1 (the ServiceAccount)", got)
			}
		})
	}
}

// TestReapStrandedBootstrapHooks_DeleteFailureIsNotCounted: a refused delete (the UID precondition
// failed because the object was replaced) is logged and not counted.
func TestReapStrandedBootstrapHooks_DeleteFailureIsNotCounted(t *testing.T) {
	c := cluster{
		app: appJSON("Failed", false, lastWrite),
		sa:  listJSON(hook("v1", saName, uid("00000000a501"), "2026-11-04T09:00:00Z", nil, nil)),
		onWrite: func(string) (string, error) {
			return "", errors.New("Precondition failed: UID in precondition does not match")
		},
	}
	fakeReapKubectl(t, c.respond(t))
	if got := reapStrandedBootstrapHooks(context.Background(), "apps", "default", io.Discard, io.Discard); got != 0 {
		t.Errorf("requested %d deletions, want 0", got)
	}
}

// TestReapStrandedBootstrapHooks_LogsDeletionRequested: a Foreground delete's 200 is a REQUEST (the
// object can remain with a deletionTimestamp until its owned Secret is gone), and the log says so.
func TestReapStrandedBootstrapHooks_LogsDeletionRequested(t *testing.T) {
	c := cluster{
		app: appJSON("Failed", false, lastWrite),
		sa:  listJSON(hook("v1", saName, uid("00000000a501"), "2026-11-04T09:00:00Z", nil, nil)),
	}
	fakeReapKubectl(t, c.respond(t))
	var out strings.Builder
	reapStrandedBootstrapHooks(context.Background(), "apps", "default", &out, io.Discard)
	if !strings.Contains(out.String(), "Deletion requested for stranded bootstrap hook serviceaccounts default/"+saName) {
		t.Errorf("log does not say deletion was requested:\n%s", out.String())
	}
	if strings.Contains(out.String(), "Removed") {
		t.Errorf("log claims a removal:\n%s", out.String())
	}
}

// TestBootstrapReapKubectl_PassesArgsAndStdin runs the real seam against a stand-in kubectl on PATH:
// the arguments arrive after the request timeout, stdin reaches the process, and a non-zero exit
// returns its stderr as the error.
func TestBootstrapReapKubectl_PassesArgsAndStdin(t *testing.T) {
	dir := t.TempDir()
	// PATH holds only the stand-in, so it uses shell builtins alone.
	script := "#!/bin/sh\nif [ \"$2\" = fail ]; then echo 'refused' >&2; exit 1; fi\necho \"$*\"\nwhile IFS= read -r l || [ -n \"$l\" ]; do echo \"$l\"; done\n"
	if err := os.WriteFile(filepath.Join(dir, "kubectl"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)

	out, err := bootstrapReapKubectl(context.Background(), "BODY", "delete", "--raw", "/x", "-f", "-")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if want := "--request-timeout=28s delete --raw /x -f -\nBODY\n"; out != want {
		t.Errorf("output = %q, want %q", out, want)
	}
	if _, err := bootstrapReapKubectl(context.Background(), "", "fail"); err == nil || !strings.Contains(err.Error(), "refused") {
		t.Errorf("error = %v, want the stand-in's stderr", err)
	}
}

// TestBootstrapReapApplies pins which environments' day-2 inspection runs the reconcile.
func TestBootstrapReapApplies(t *testing.T) {
	withRepo := func(pm types.PlacementMode) *types.ProjectConfig {
		vc := &types.ProjectConfig{PlacementMode: pm}
		vc.Repositories.AppsDestinationRepo = "https://github.com/acme/apps"
		return vc
	}
	for _, tc := range []struct {
		name string
		vc   *types.ProjectConfig
		want bool
	}{
		{"dedicated", withRepo(types.PlacementModeDedicated), true},
		{"legacy empty placement is dedicated", withRepo(""), true},
		{"namespace", withRepo(types.PlacementModeNamespace), false},
		{"vcluster", withRepo(types.PlacementModeVcluster), false},
		{"no apps repo", &types.ProjectConfig{PlacementMode: types.PlacementModeDedicated}, false},
		{"nil config", nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := bootstrapReapApplies(tc.vc, "aws"); got != tc.want {
				t.Errorf("bootstrapReapApplies = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestReapStrandedBootstrapHooks_FutureWriteTimeReapsNothing: an Application carrying a write time in
// the runner's future (a restored or copied Application) reaps nothing, says why, and lists nothing.
func TestReapStrandedBootstrapHooks_FutureWriteTimeReapsNothing(t *testing.T) {
	calls := fakeReapKubectl(t, func(args string) (string, error) {
		if args == reapAppGet {
			return appJSON("Failed", false, lastWrite, "2027-01-01T00:00:00Z"), nil
		}
		t.Errorf("unexpected call after a future write time: %s", args)
		return "", nil
	})
	var out strings.Builder
	if got := reapStrandedBootstrapHooks(context.Background(), "apps", "default", &out, io.Discard); got != 0 {
		t.Errorf("requested %d deletions, want 0", got)
	}
	if len(*calls) != 1 {
		t.Errorf("%d calls, want only the Application read", len(*calls))
	}
	if !strings.Contains(out.String(), "write time in the future (2027-01-01T00:00:00Z") {
		t.Errorf("refusal not logged:\n%s", out.String())
	}
}
