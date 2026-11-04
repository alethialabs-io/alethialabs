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

// listOf renders items as a kubectl list payload, labels included.
func listOf(t *testing.T, items ...esItem) string {
	t.Helper()
	type meta struct {
		Name      string            `json:"name"`
		Namespace string            `json:"namespace,omitempty"`
		Labels    map[string]string `json:"labels,omitempty"`
	}
	type item struct {
		Metadata meta `json:"metadata"`
	}
	out := struct {
		Items []item `json:"items"`
	}{Items: []item{}}
	for _, it := range items {
		out.Items = append(out.Items, item{Metadata: meta{Name: it.name, Namespace: it.ns, Labels: it.labels}})
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
	})
	var stdout, stderr bytes.Buffer
	PruneChartBindingSecrets("env-1", []string{"apps"}, []BindingSecretRef{{Namespace: "apps", Name: "keep-me"}}, &stdout, &stderr)

	if !stub.calledWith("delete externalsecret -n apps drop-me") {
		t.Errorf("the undeclared binding was not pruned; calls: %v", stub.calls())
	}
	if stub.calledWith("keep-me --ignore-not-found") {
		t.Errorf("a declared binding was deleted; calls: %v", stub.calls())
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
		if stub.calledWith(name + " --ignore-not-found") {
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

	if !stub.calledWith("delete externalsecret -n old-charts gone") {
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

	if stub.calledWith("delete externalsecret -n apps web-db") {
		t.Errorf("the declared apps/web-db was deleted; calls: %v", stub.calls())
	}
	if !stub.calledWith("delete externalsecret -n other web-db") {
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
