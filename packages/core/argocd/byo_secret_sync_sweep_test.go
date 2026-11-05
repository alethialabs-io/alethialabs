// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

// sweepNS renders a namespace list payload: each entry is a name and its labels.
func sweepNS(t *testing.T, items map[string]map[string]string) string {
	t.Helper()
	var in []esItem
	for name, labels := range items {
		in = append(in, esItem{"", name, labels})
	}
	return listOf(t, in...)
}

// byoNSLabels are the labels RenderByoNamespaces stamps on a namespace of environment env.
func byoNSLabels(env string) map[string]string {
	return map[string]string{byoNamespaceManagedByLabel: byoNamespaceManagedByValue, ByoBindingOwnerLabel: env}
}

// sweepObjects renders a raw list of one kind, every object carrying testUID.
func sweepObjects(t *testing.T, ns string, items ...esItem) string {
	t.Helper()
	for i := range items {
		items[i].ns = ns
	}
	return listOf(t, items...)
}

// sweepDiscovery are the discovery answers for ESO 0.9.20's groups, most specific path first
// because the stub takes the first rule whose text the call contains.
func sweepDiscovery(t *testing.T) []stubRule {
	t.Helper()
	esRes, _ := json.Marshal(map[string]any{"resources": []map[string]any{
		{"name": "externalsecrets", "kind": "ExternalSecret", "namespaced": true, "verbs": []string{"delete", "get", "list"}},
		{"name": "externalsecrets/status", "kind": "ExternalSecret", "namespaced": true, "verbs": []string{"get"}},
		{"name": "secretstores", "kind": "SecretStore", "namespaced": true, "verbs": []string{"delete", "get", "list"}},
		{"name": "clustersecretstores", "kind": "ClusterSecretStore", "namespaced": false, "verbs": []string{"delete", "get", "list"}},
	}})
	genRes, _ := json.Marshal(map[string]any{"resources": []map[string]any{
		{"name": "passwords", "kind": "Password", "namespaced": true, "verbs": []string{"delete", "get", "list"}},
	}})
	groups, _ := json.Marshal(map[string]any{"groups": []map[string]any{
		{"name": "apps", "preferredVersion": map[string]string{"version": "v1"}},
		{"name": "external-secrets.io", "preferredVersion": map[string]string{"version": "v1beta1"}},
		{"name": "generators.external-secrets.io", "preferredVersion": map[string]string{"version": "v1alpha1"}},
	}})
	return []stubRule{
		{Match: "get --raw /apis/external-secrets.io/v1beta1", Stdout: string(esRes)},
		{Match: "get --raw /apis/generators.external-secrets.io/v1alpha1", Stdout: string(genRes)},
		{Match: "get --raw /apis", Stdout: string(groups)},
	}
}

// emptyList answers any per-namespace listing the test did not seed.
const emptyList = `{"items":[]}`

// sweepStub builds a stub: the namespace listing, then per-namespace object listings, then
// discovery. Any other listing answers empty.
func sweepStub(t *testing.T, namespaces string, lists ...stubRule) *kubectlStub {
	t.Helper()
	rules := []stubRule{{Match: "get namespaces", Stdout: namespaces}, {Match: "delete --raw", Stdout: `{"kind":"ExternalSecret"}`}}
	rules = append(rules, lists...)
	rules = append(rules, stubRule{Match: "/namespaces/", Stdout: emptyList})
	rules = append(rules, sweepDiscovery(t)...)
	return newKubectlStub(t, 0, rules...)
}

// sweepDelete is the raw delete path the sweep issues for one object.
func sweepDelete(groupVersion, ns, resource, name string) string {
	return "delete --raw /apis/" + groupVersion + "/namespaces/" + ns + "/" + resource + "/" + name + " -f -"
}

// TestSweepByoSecretSync_RemovesOnlyWhatNoBindingDeclares: a declared binding ExternalSecret is
// kept. A chart-authored ExternalSecret beside it, one carrying the runner's own marker and owner
// labels, a SecretStore that shares the declared binding's NAME, and a generator are all deleted:
// identity is (namespace, name, kind), never labels.
func TestSweepByoSecretSync_RemovesOnlyWhatNoBindingDeclares(t *testing.T) {
	stub := sweepStub(t,
		sweepNS(t, map[string]map[string]string{"byo-pay": byoNSLabels("env-1")}),
		stubRule{Match: "get --raw /apis/external-secrets.io/v1beta1/namespaces/byo-pay/externalsecrets", Stdout: sweepObjects(t, "byo-pay",
			esItem{name: "api-db", labels: owned("env-1")},
			esItem{name: "chart-made"},
			esItem{name: "forged", labels: owned("env-1")},
		)},
		stubRule{Match: "get --raw /apis/external-secrets.io/v1beta1/namespaces/byo-pay/secretstores", Stdout: sweepObjects(t, "byo-pay",
			esItem{name: "api-db"},
		)},
		stubRule{Match: "get --raw /apis/generators.external-secrets.io/v1alpha1/namespaces/byo-pay/passwords", Stdout: sweepObjects(t, "byo-pay",
			esItem{name: "pw"},
		)},
	)
	var stdout, stderr bytes.Buffer
	warnings := SweepByoSecretSyncObjects("env-1", []BindingSecretRef{{Namespace: "byo-pay", Name: "api-db"}}, &stdout, &stderr)

	if stub.calledWith(sweepDelete("external-secrets.io/v1beta1", "byo-pay", "externalsecrets", "api-db")) {
		t.Errorf("the declared binding ExternalSecret was deleted; calls: %v", stub.calls())
	}
	for _, d := range []string{
		sweepDelete("external-secrets.io/v1beta1", "byo-pay", "externalsecrets", "chart-made"),
		sweepDelete("external-secrets.io/v1beta1", "byo-pay", "externalsecrets", "forged"),
		sweepDelete("external-secrets.io/v1beta1", "byo-pay", "secretstores", "api-db"),
		sweepDelete("generators.external-secrets.io/v1alpha1", "byo-pay", "passwords", "pw"),
	} {
		if !stub.calledWith(d) {
			t.Errorf("missing delete %q; calls: %v\nstderr: %s", d, stub.calls(), stderr.String())
		}
	}
	if len(warnings) != 4 {
		t.Errorf("want one Deploy-tab warning per deletion (4), got %d: %q", len(warnings), warnings)
	}
	if len(warnings) > 0 && !strings.Contains(strings.Join(warnings, "\n"), `ExternalSecret "chart-made" from BYO chart namespace "byo-pay"`) {
		t.Errorf("the warning does not name the object: %q", warnings)
	}
	opts := stub.appliedManifests()
	if !strings.Contains(opts, `"preconditions":{"uid":"`+testUID+`"}`) || !strings.Contains(opts, `"propagationPolicy":"Foreground"`) {
		t.Errorf("the delete is not uid-pinned with Foreground propagation: %q", opts)
	}
	if strings.Contains(stdout.String()+stderr.String(), `"kind":"ExternalSecret"`) {
		t.Errorf("a deleted object's JSON reached the log")
	}
	if stub.calledWith("clustersecretstores") {
		t.Errorf("a cluster-scoped resource was listed; calls: %v", stub.calls())
	}
}

// TestSweepByoSecretSync_OnlyThisEnvironmentsBYONamespaces: a namespace whose owner label names
// another environment, one without the BYO marker, and a reserved platform namespace are never
// listed, even when the API server's selector is ignored and returns them.
func TestSweepByoSecretSync_OnlyThisEnvironmentsBYONamespaces(t *testing.T) {
	stub := sweepStub(t, sweepNS(t, map[string]map[string]string{
		"byo-other": byoNSLabels("env-2"),
		"plain":     {ByoBindingOwnerLabel: "env-1"},
		"default":   byoNSLabels("env-1"),
	}))
	var stdout, stderr bytes.Buffer
	warnings := SweepByoSecretSyncObjects("env-1", nil, &stdout, &stderr)

	for _, ns := range []string{"byo-other", "plain", "default"} {
		if stub.calledWith("/namespaces/" + ns + "/") {
			t.Errorf("namespace %s was swept; calls: %v", ns, stub.calls())
		}
	}
	if stub.calledWith("delete") || len(warnings) != 0 {
		t.Errorf("something was deleted; calls: %v", stub.calls())
	}
	if !stub.calledWith("-l " + byoNamespaceManagedByLabel + "=" + byoNamespaceManagedByValue + "," + ByoBindingOwnerLabel + "=env-1") {
		t.Errorf("the namespace listing did not select on the BYO and owner labels; calls: %v", stub.calls())
	}
}

// TestSweepByoSecretSync_AFailedReadDeletesNothing: a listing that fails part-way stops the sweep
// before any delete, so an unknown set is never treated as an empty one.
func TestSweepByoSecretSync_AFailedReadDeletesNothing(t *testing.T) {
	stub := sweepStub(t,
		sweepNS(t, map[string]map[string]string{"byo-a": byoNSLabels("env-1"), "byo-b": byoNSLabels("env-1")}),
		stubRule{Match: "/namespaces/byo-a/externalsecrets", Stdout: sweepObjects(t, "byo-a", esItem{name: "chart-made"})},
		stubRule{Match: "/namespaces/byo-b/secretstores", Exit: 1},
	)
	var stdout, stderr bytes.Buffer
	warnings := SweepByoSecretSyncObjects("env-1", nil, &stdout, &stderr)
	if stub.calledWith("delete") || len(warnings) != 0 {
		t.Errorf("a sweep with a failed read deleted something; calls: %v", stub.calls())
	}
	if !strings.Contains(stderr.String(), "not sweeping") {
		t.Errorf("the skipped sweep was not reported: %s", stderr.String())
	}
}

// TestSweepByoSecretSync_RefusesAnUnusableOwner: without a usable owner value nothing is listed.
func TestSweepByoSecretSync_RefusesAnUnusableOwner(t *testing.T) {
	stub := sweepStub(t, emptyList)
	var stdout, stderr bytes.Buffer
	if w := SweepByoSecretSyncObjects("env 1;rm", nil, &stdout, &stderr); len(w) != 0 || len(stub.calls()) != 0 {
		t.Errorf("an unusable owner reached kubectl; calls: %v", stub.calls())
	}
}
