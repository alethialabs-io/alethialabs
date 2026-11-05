// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

// esItem is one object in a canned `kubectl get … -o json` list.
type esItem struct {
	ns, name string
	labels   map[string]string
}

// testUID is the uid every listed ExternalSecret carries unless a test overrides the listing.
const testUID = "0f8fad5b-d9cb-469f-a165-70867728950e"

// rawDelete is the uid-pinned delete the prune issues for ns/name.
func rawDelete(ns, name string) string {
	return "delete --raw /apis/external-secrets.io/v1beta1/namespaces/" + ns + "/externalsecrets/" + name + " -f "
}

// listOf renders items as a kubectl list payload, labels included.
func listOf(t *testing.T, items ...esItem) string {
	t.Helper()
	type meta struct {
		Name      string            `json:"name"`
		Namespace string            `json:"namespace,omitempty"`
		UID       string            `json:"uid"`
		Labels    map[string]string `json:"labels,omitempty"`
	}
	type item struct {
		APIVersion string `json:"apiVersion"`
		Metadata   meta   `json:"metadata"`
	}
	out := struct {
		Items []item `json:"items"`
	}{Items: []item{}}
	for _, it := range items {
		out.Items = append(out.Items, item{APIVersion: "external-secrets.io/v1beta1", Metadata: meta{Name: it.name, Namespace: it.ns, UID: testUID, Labels: it.labels}})
	}
	b, err := json.Marshal(out)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// owned is the label set the runner stamps on a binding ExternalSecret of environment env.
func owned(env string) map[string]string {
	return map[string]string{ByoBindingSecretLabel: "true", ByoBindingOwnerLabel: env}
}

// noNamespaces answers the owned-namespace lookup with an empty list.
var noNamespaces = stubRule{Match: "get namespaces", Stdout: `{"items":[]}`}

// TestPruneChartBindingSecrets_DeletesOnlyUndeclaredOwnObjects: a declared binding is kept, an
// undeclared one of this environment is deleted, and the namespace scope is per-namespace, never -A.
func TestPruneChartBindingSecrets_DeletesOnlyUndeclaredOwnObjects(t *testing.T) {
	stub := newKubectlStub(t, 0, noNamespaces, stubRule{
		Match:  "get externalsecrets -n apps",
		Stdout: listOf(t, esItem{"apps", "keep-me", owned("env-1")}, esItem{"apps", "drop-me", owned("env-1")}),
	}, stubRule{
		// A real raw delete answers with the deleted object; none of it may reach the log.
		Match:  "delete --raw",
		Stdout: `{"kind":"ExternalSecret","metadata":{"name":"drop-me"}}`,
	})
	var stdout, stderr bytes.Buffer
	PruneChartBindingSecrets("env-1", []string{"apps"}, []BindingSecretRef{{Namespace: "apps", Name: "keep-me"}}, &stdout, &stderr)

	if !stub.calledWith(rawDelete("apps", "drop-me")) {
		t.Errorf("the undeclared binding was not pruned; calls: %v", stub.calls())
	}
	if stub.calledWith("/keep-me ") {
		t.Errorf("a declared binding was deleted; calls: %v", stub.calls())
	}
	if !strings.Contains(stub.appliedManifests(), `"preconditions":{"uid":"`+testUID+`"}`) {
		t.Errorf("the delete was not pinned to the listed uid; options sent: %q", stub.appliedManifests())
	}
	if !strings.Contains(stub.appliedManifests(), `"propagationPolicy":"Foreground"`) {
		t.Errorf("the delete does not remove the owned Secret first; options sent: %q", stub.appliedManifests())
	}
	if log := stdout.String() + stderr.String(); strings.Contains(log, `"kind":"ExternalSecret"`) {
		t.Errorf("the deleted object's JSON reached the job log:\n%s", log)
	}
	if !strings.Contains(stdout.String(), "deletion requested for apps/drop-me") {
		t.Errorf("the deletion was not logged:\n%s", stdout.String())
	}
	if stub.calledWith(" -A") {
		t.Errorf("the prune listed across all namespaces; calls: %v", stub.calls())
	}
	if !stub.calledWith("-l " + ByoBindingSecretLabel + "=true," + ByoBindingOwnerLabel + "=env-1") {
		t.Errorf("the listing did not select on the owner label; calls: %v", stub.calls())
	}
}

// TestPruneChartBindingSecrets_LeavesForeignAndUnownedObjects: on a shared host the listing can
// return objects this environment does not own (another environment's, or a marker with no owner
// label at all). Even when the API server's selector is ignored, neither is deleted.
func TestPruneChartBindingSecrets_LeavesForeignAndUnownedObjects(t *testing.T) {
	stub := newKubectlStub(t, 0, noNamespaces, stubRule{
		Match: "get externalsecrets -n apps",
		Stdout: listOf(t,
			esItem{"apps", "foreign", owned("env-2")},
			esItem{"apps", "unowned", map[string]string{ByoBindingSecretLabel: "true"}},
			esItem{"tenant-ns", "elsewhere", owned("env-1")}, // not the namespace that was listed
		),
	})
	var stdout, stderr bytes.Buffer
	PruneChartBindingSecrets("env-1", []string{"apps"}, nil, &stdout, &stderr)

	for _, name := range []string{"foreign", "unowned", "elsewhere"} {
		if stub.calledWith("/" + name + " ") {
			t.Errorf("%s was deleted by an environment that does not own it; calls: %v", name, stub.calls())
		}
	}
}

// TestPruneChartBindingSecrets_FindsOwnedNamespaceOfADetachedChart: a namespace no binding is
// declared in any more is still swept when it carries this environment's owner label — and a
// namespace carrying another environment's label is not listed at all.
func TestPruneChartBindingSecrets_FindsOwnedNamespaceOfADetachedChart(t *testing.T) {
	stub := newKubectlStub(t, 0,
		stubRule{Match: "get namespaces -l " + ByoBindingOwnerLabel + "=env-1", Stdout: listOf(t,
			esItem{"", "old-charts", map[string]string{ByoBindingOwnerLabel: "env-1"}},
			esItem{"", "tenant-b", map[string]string{ByoBindingOwnerLabel: "env-2"}},
		)},
		stubRule{Match: "get externalsecrets -n old-charts", Stdout: listOf(t, esItem{"old-charts", "gone", owned("env-1")})},
	)
	var stdout, stderr bytes.Buffer
	PruneChartBindingSecrets("env-1", nil, nil, &stdout, &stderr)

	if !stub.calledWith(rawDelete("old-charts", "gone")) {
		t.Errorf("a detached chart's binding was not swept; calls: %v", stub.calls())
	}
	if stub.calledWith("-n tenant-b") {
		t.Errorf("a namespace labelled for another environment was listed; calls: %v", stub.calls())
	}
}

// TestPruneChartBindingSecrets_SameNameInTwoNamespaces: identity is (namespace, name), so keeping
// apps/web-db does not keep other/web-db.
func TestPruneChartBindingSecrets_SameNameInTwoNamespaces(t *testing.T) {
	stub := newKubectlStub(t, 0, noNamespaces,
		stubRule{Match: "get externalsecrets -n apps", Stdout: listOf(t, esItem{"apps", "web-db", owned("env-1")})},
		stubRule{Match: "get externalsecrets -n other", Stdout: listOf(t, esItem{"other", "web-db", owned("env-1")})},
	)
	var stdout, stderr bytes.Buffer
	PruneChartBindingSecrets("env-1", []string{"apps", "other"}, []BindingSecretRef{{Namespace: "apps", Name: "web-db"}}, &stdout, &stderr)

	if stub.calledWith(rawDelete("apps", "web-db")) {
		t.Errorf("the declared apps/web-db was deleted; calls: %v", stub.calls())
	}
	if !stub.calledWith(rawDelete("other", "web-db")) {
		t.Errorf("the undeclared other/web-db was kept; calls: %v", stub.calls())
	}
}

// TestPruneChartBindingSecrets_FailsClosed: every unreadable or unsafe input stops the prune with a
// warning and no delete.
func TestPruneChartBindingSecrets_FailsClosed(t *testing.T) {
	cases := []struct {
		name     string
		owner    string
		ns       []string
		rules    []stubRule
		wantWarn string
	}{
		{name: "no owner", owner: "", ns: []string{"apps"}, wantWarn: "no usable environment owner label"},
		{name: "owner is not a label value", owner: "env-1; rm -rf /", ns: []string{"apps"}, wantWarn: "no usable environment owner label"},
		{
			name: "namespace lookup fails", owner: "env-1", ns: []string{"apps"},
			rules:    []stubRule{{Match: "get namespaces", Exit: 1}},
			wantWarn: "could not list BYO binding namespaces",
		},
		{
			name: "namespace lookup unparseable", owner: "env-1", ns: []string{"apps"},
			rules:    []stubRule{{Match: "get namespaces", Stdout: "not json"}},
			wantWarn: "could not list BYO binding namespaces",
		},
		{
			// apps lists cleanly with a stale object, zzz then fails: nothing at all is deleted.
			name: "a later namespace's list fails", owner: "env-1", ns: []string{"apps", "zzz"},
			rules: []stubRule{
				noNamespaces,
				{Match: "get externalsecrets -n apps", Stdout: listOf(t, esItem{"apps", "drop-me", owned("env-1")})},
				{Match: "get externalsecrets -n zzz", Exit: 1},
			},
			wantWarn: "could not list BYO binding ExternalSecrets to prune in zzz",
		},
		{
			name: "unparseable ExternalSecret list", owner: "env-1", ns: []string{"apps"},
			rules:    []stubRule{noNamespaces, {Match: "get externalsecrets -n apps", Stdout: "not json"}},
			wantWarn: "could not parse BYO binding ExternalSecret list",
		},
		{
			name: "oddly-named object", owner: "env-1", ns: []string{"apps"},
			rules:    []stubRule{noNamespaces, {Match: "get externalsecrets -n apps", Stdout: listOf(t, esItem{"apps", "bad;name", owned("env-1")})}},
			wantWarn: "oddly-named ExternalSecret",
		},
		{name: "oddly-named namespace", owner: "env-1", ns: []string{"Bad NS"}, rules: []stubRule{noNamespaces}, wantWarn: "oddly-named namespace"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			stub := newKubectlStub(t, 0, tc.rules...)
			var stdout, stderr bytes.Buffer
			PruneChartBindingSecrets(tc.owner, tc.ns, nil, &stdout, &stderr)
			if !strings.Contains(stderr.String(), tc.wantWarn) {
				t.Errorf("stderr = %q, want a warning containing %q", stderr.String(), tc.wantWarn)
			}
			if stub.calledWith("delete") {
				t.Errorf("a delete was issued: %v", stub.calls())
			}
			if strings.Contains(strings.Join(stub.calls(), "\n"), "rm -rf") {
				t.Errorf("an unsafe owner reached kubectl: %v", stub.calls())
			}
		})
	}
}

// TestPruneChartBindingSecrets_WarnsWhenADeleteFails: a failed delete is reported, not fatal.
func TestPruneChartBindingSecrets_WarnsWhenADeleteFails(t *testing.T) {
	newKubectlStub(t, 1, noNamespaces, stubRule{
		Match: "get externalsecrets -n apps", Stdout: listOf(t, esItem{"apps", "stale-one", owned("env-1")}),
	})
	var stdout, stderr bytes.Buffer
	PruneChartBindingSecrets("env-1", []string{"apps"}, nil, &stdout, &stderr)
	if !strings.Contains(stderr.String(), "failed to prune BYO binding ExternalSecret apps/stale-one") {
		t.Fatalf("stderr missing the delete-failure warning:\n%s", stderr.String())
	}
}

// TestPruneChartBindingSecrets_NeverSelectsANonByoObject: an object carrying this environment's owner
// label but NOT the binding marker (a first-class service's ExternalSecret, for instance) is never
// deleted, even when the listing returns it.
func TestPruneChartBindingSecrets_NeverSelectsANonByoObject(t *testing.T) {
	stub := newKubectlStub(t, 0, noNamespaces, stubRule{
		Match: "get externalsecrets -n default",
		Stdout: listOf(t,
			esItem{"default", "web-database-orders", map[string]string{ByoBindingOwnerLabel: "env-1"}},
			esItem{"default", "marker-false", map[string]string{ByoBindingSecretLabel: "false", ByoBindingOwnerLabel: "env-1"}},
		),
	})
	var stdout, stderr bytes.Buffer
	PruneChartBindingSecrets("env-1", []string{"default"}, nil, &stdout, &stderr)
	if stub.calledWith("delete") {
		t.Fatalf("an object without the binding marker was deleted: %v", stub.calls())
	}
}

// TestPruneChartBindingSecrets_RefusesWithoutAUsableUID: an object whose listing carries no uid
// (or a malformed one) cannot be delete-pinned, so it is skipped rather than deleted unguarded.
func TestPruneChartBindingSecrets_RefusesWithoutAUsableUID(t *testing.T) {
	for name, uid := range map[string]string{"missing": "", "malformed": "x; rm -rf /"} {
		t.Run(name, func(t *testing.T) {
			list := `{"items":[{"apiVersion":"external-secrets.io/v1beta1","metadata":{"name":"drop-me","namespace":"apps","uid":` +
				strconvQuote(uid) + `,"labels":{"alethia.io/byo-binding":"true","alethia.io/environment-id":"env-1"}}}]}`
			stub := newKubectlStub(t, 0, noNamespaces, stubRule{Match: "get externalsecrets -n apps", Stdout: list})
			var stdout, stderr bytes.Buffer
			PruneChartBindingSecrets("env-1", []string{"apps"}, nil, &stdout, &stderr)
			if stub.calledWith("delete") {
				t.Fatalf("a delete was issued without a usable uid: %v", stub.calls())
			}
			if !strings.Contains(stderr.String(), "no usable uid") {
				t.Errorf("the refusal was not reported: %q", stderr.String())
			}
		})
	}
}

// strconvQuote JSON-quotes s for a hand-built listing.
func strconvQuote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// TestPruneChartBindingSecrets_KeepsADeclaredSourceOnlyWhenTheObjectReadsIt: a binding declared with
// the db-user source is kept only when its live object carries that source label. The same binding
// read from the administrative credential (no label, or another value) is deleted even though it is
// declared, and the log says why; a binding declared with no source is kept whatever it carries.
func TestPruneChartBindingSecrets_KeepsADeclaredSourceOnlyWhenTheObjectReadsIt(t *testing.T) {
	withSource := func(v string) map[string]string {
		l := owned("env-1")
		l[ByoBindingSourceLabel] = v
		return l
	}
	stub := newKubectlStub(t, 0, noNamespaces, stubRule{
		Match: "get externalsecrets -n apps",
		Stdout: listOf(t,
			esItem{"apps", "own-user", withSource(ByoBindingSourceDBUser)},
			esItem{"apps", "admin-cred", owned("env-1")},
			esItem{"apps", "other-source", withSource("something-else")},
			esItem{"apps", "no-source-declared", owned("env-1")},
		),
	})
	var stdout, stderr bytes.Buffer
	PruneChartBindingSecrets("env-1", []string{"apps"}, []BindingSecretRef{
		{Namespace: "apps", Name: "own-user", Source: ByoBindingSourceDBUser},
		{Namespace: "apps", Name: "admin-cred", Source: ByoBindingSourceDBUser},
		{Namespace: "apps", Name: "other-source", Source: ByoBindingSourceDBUser},
		{Namespace: "apps", Name: "no-source-declared"},
	}, &stdout, &stderr)

	for _, kept := range []string{"own-user", "no-source-declared"} {
		if stub.calledWith("/" + kept + " ") {
			t.Errorf("%s was deleted; calls: %v", kept, stub.calls())
		}
	}
	for _, dropped := range []string{"admin-cred", "other-source"} {
		if !stub.calledWith(rawDelete("apps", dropped)) {
			t.Errorf("%s was kept although it does not read the declared source; calls: %v", dropped, stub.calls())
		}
		if !strings.Contains(stdout.String(), "does not read its binding's own credential: deletion requested for apps/"+dropped) {
			t.Errorf("the reason for deleting %s was not logged:\n%s", dropped, stdout.String())
		}
	}
}
