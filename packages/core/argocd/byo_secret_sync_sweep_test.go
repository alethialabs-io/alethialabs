// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
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
	warnings := SweepByoSecretSyncObjects("env-1", []BindingSecretRef{{Namespace: "byo-pay", Name: "api-db"}}, nil, &stdout, &stderr)

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
	warnings := SweepByoSecretSyncObjects("env-1", nil, nil, &stdout, &stderr)

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
	warnings := SweepByoSecretSyncObjects("env-1", nil, nil, &stdout, &stderr)
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
	if w := SweepByoSecretSyncObjects("env 1;rm", nil, nil, &stdout, &stderr); len(w) != 0 || len(stub.calls()) != 0 {
		t.Errorf("an unusable owner reached kubectl; calls: %v", stub.calls())
	}
}

// renderedBinding is a binding ExternalSecret document in the shape the runner's renderer writes.
const renderedBinding = `apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: api-db
  namespace: byo-pay
  labels:
    app.kubernetes.io/name: api-db
    app.kubernetes.io/managed-by: alethia
    alethia.io/byo-binding: "true"
    alethia.io/environment-id: "env-1"
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: secretstore-aws
    kind: ClusterSecretStore
  target:
    name: api-db
    creationPolicy: Owner
  data:
    - secretKey: password
      remoteRef:
        key: acme/rds/master
        property: password
`

// liveBindingSpec is renderedBinding's spec as the API server stores it: ESO's CRD defaults filled
// in, and refreshInterval spelled another way.
func liveBindingSpec() map[string]any {
	return map[string]any{
		"refreshInterval": "1h0m0s",
		"secretStoreRef":  map[string]any{"name": "secretstore-aws", "kind": "ClusterSecretStore"},
		"target":          map[string]any{"name": "api-db", "creationPolicy": "Owner", "deletionPolicy": "Retain"},
		"data": []any{map[string]any{"secretKey": "password", "remoteRef": map[string]any{
			"key": "acme/rds/master", "property": "password",
			"conversionStrategy": "Default", "decodingStrategy": "None", "metadataPolicy": "None",
		}}},
	}
}

// liveBindingList renders one listed ExternalSecret api-db in byo-pay with the given spec.
func liveBindingList(t *testing.T, spec map[string]any) string {
	t.Helper()
	b, err := json.Marshal(map[string]any{"items": []any{map[string]any{
		"apiVersion": "external-secrets.io/v1beta1",
		"metadata":   map[string]any{"name": "api-db", "namespace": "byo-pay", "uid": testUID, "resourceVersion": "4242"},
		"spec":       spec,
	}}})
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// restoreStub is a cluster with one BYO namespace holding the given api-db; replaceExit is how a
// replace answers.
func restoreStub(t *testing.T, spec map[string]any, replaceExit int) *kubectlStub {
	t.Helper()
	return newKubectlStub(t, 0, append([]stubRule{
		{Match: "get namespaces", Stdout: sweepNS(t, map[string]map[string]string{"byo-pay": byoNSLabels("env-1")})},
		{Match: "replace -f -", Exit: replaceExit},
		{Match: "/namespaces/byo-pay/externalsecrets", Stdout: liveBindingList(t, spec)},
		{Match: "/namespaces/", Stdout: emptyList},
	}, sweepDiscovery(t)...)...)
}

// sweepRestore runs the sweep over the one declared binding api-db, rendered as renderedBinding.
func sweepRestore() ([]string, string) {
	var stdout, stderr bytes.Buffer
	ref := BindingSecretRef{Namespace: "byo-pay", Name: "api-db"}
	w := SweepByoSecretSyncObjects("env-1", []BindingSecretRef{ref}, map[BindingSecretRef]string{ref: renderedBinding}, &stdout, &stderr)
	return w, stderr.String()
}

// TestSweepByoSecretSync_RestoresASquattedBindingInPlace: a kept binding must be exactly the runner's
// own object. A live object at the binding's name whose spec carries a dataFrom is replaced with the
// rendered object, pinned to its uid and resourceVersion: the result's spec is exactly the rendered
// one, and nothing at that name is deleted.
func TestSweepByoSecretSync_RestoresASquattedBindingInPlace(t *testing.T) {
	spec := liveBindingSpec()
	spec["dataFrom"] = []any{map[string]any{"find": map[string]any{"name": map[string]any{"regexp": ".*"}}}}
	stub := restoreStub(t, spec, 0)
	warnings, stderr := sweepRestore()

	if stub.calledWith("delete") {
		t.Fatalf("a kept binding was deleted; calls: %v", stub.calls())
	}
	if !stub.calledWith("replace -f -") {
		t.Fatalf("the squatted binding was not replaced; calls: %v\nstderr: %s", stub.calls(), stderr)
	}
	var sent struct {
		Metadata struct {
			Name            string `json:"name"`
			UID             string `json:"uid"`
			ResourceVersion string `json:"resourceVersion"`
		} `json:"metadata"`
		Spec map[string]any `json:"spec"`
	}
	if err := json.Unmarshal([]byte(stub.appliedManifests()), &sent); err != nil {
		t.Fatalf("the replace body is not one JSON object: %v\n%s", err, stub.appliedManifests())
	}
	if sent.Metadata.UID != testUID || sent.Metadata.ResourceVersion != "4242" {
		t.Errorf("the replace is not pinned to the live uid and resourceVersion: %+v", sent.Metadata)
	}
	var want struct {
		Spec map[string]any `yaml:"spec"`
	}
	if err := yaml.Unmarshal([]byte(renderedBinding), &want); err != nil {
		t.Fatal(err)
	}
	if _, has := sent.Spec["dataFrom"]; has || !byoBindingSpecMatches(sent.Spec, want.Spec) {
		t.Errorf("the replaced spec is not exactly the rendered one: %v", sent.Spec)
	}
	if len(warnings) != 1 || !strings.Contains(warnings[0], `restored binding ExternalSecret "api-db"`) {
		t.Errorf("the restore was not reported: %q", warnings)
	}
}

// TestSweepByoSecretSync_RestoresAChangedStore: the comparison is the whole spec, so a binding whose
// store reference was changed is restored too.
func TestSweepByoSecretSync_RestoresAChangedStore(t *testing.T) {
	spec := liveBindingSpec()
	spec["secretStoreRef"] = map[string]any{"name": "chart-store", "kind": "SecretStore"}
	stub := restoreStub(t, spec, 0)
	sweepRestore()
	if !stub.calledWith("replace -f -") {
		t.Errorf("a binding pointed at another store was not restored; calls: %v", stub.calls())
	}
}

// TestSweepByoSecretSync_LeavesTheRunnersOwnBindingUnwritten: a live binding whose spec is the
// rendered one plus ESO's CRD defaults is not written at all.
func TestSweepByoSecretSync_LeavesTheRunnersOwnBindingUnwritten(t *testing.T) {
	stub := restoreStub(t, liveBindingSpec(), 0)
	warnings, _ := sweepRestore()
	if stub.calledWith("replace") || stub.calledWith("delete") || len(warnings) != 0 {
		t.Errorf("the runner's own binding was written; calls: %v, warnings: %q", stub.calls(), warnings)
	}
}

// TestSweepByoSecretSync_AConflictIsReportedNotRetried: a replace the API server refuses (the object
// changed since it was read) is reported once, on the Deploy tab, and not retried.
func TestSweepByoSecretSync_AConflictIsReportedNotRetried(t *testing.T) {
	spec := liveBindingSpec()
	spec["dataFrom"] = []any{map[string]any{"extract": map[string]any{"key": "anything"}}}
	stub := restoreStub(t, spec, 1)
	warnings, _ := sweepRestore()

	n := 0
	for _, c := range stub.calls() {
		if strings.HasPrefix(c, "replace") {
			n++
		}
	}
	if n != 1 {
		t.Errorf("replace was issued %d time(s), want exactly once; calls: %v", n, stub.calls())
	}
	if stub.calledWith("delete") {
		t.Errorf("a refused replace fell back to a delete; calls: %v", stub.calls())
	}
	if len(warnings) != 1 || !strings.Contains(warnings[0], "could not restore it on this deploy") {
		t.Errorf("the refused replace was not reported: %q", warnings)
	}
}

// TestByoSweepPathSafe pins the path check: a DNS-1123 subdomain and nothing else.
func TestByoSweepPathSafe(t *testing.T) {
	for in, want := range map[string]bool{
		"external-secrets.io": true, "v1beta1": true, "api-db": true, "a.b-c.d": true,
		"": false, strings.Repeat("a", 254): false, strings.Repeat("a", 64): false,
		"a..b": false, "Upper": false, "-lead": false, "a/b": false, "a b": false,
	} {
		if got := byoSweepPathSafe(in); got != want {
			t.Errorf("byoSweepPathSafe(%q) = %v, want %v", in, got, want)
		}
	}
}

// TestSweepByoSecretSync_EveryReadFailureDeletesNothing walks each read the sweep makes and fails it,
// or answers it with something unusable. Every one stops the sweep before any write.
func TestSweepByoSecretSync_EveryReadFailureDeletesNothing(t *testing.T) {
	ns := sweepNS(t, map[string]map[string]string{"byo-pay": byoNSLabels("env-1")})
	cases := []struct {
		name  string
		rules []stubRule
	}{
		{"namespace list fails", []stubRule{{Match: "get namespaces", Exit: 1}}},
		{"namespace list is not JSON", []stubRule{{Match: "get namespaces", Stdout: "nope"}}},
		{"group discovery fails", []stubRule{{Match: "get namespaces", Stdout: ns}, {Match: "get --raw /apis", Exit: 1}}},
		{"group discovery is not JSON", []stubRule{{Match: "get namespaces", Stdout: ns}, {Match: "get --raw /apis", Stdout: "nope"}}},
		{"a group name is not a path", []stubRule{{Match: "get namespaces", Stdout: ns}, {Match: "get --raw /apis",
			Stdout: `{"groups":[{"name":"Bad_Group.external-secrets.io","preferredVersion":{"version":"v1"}}]}`}}},
		{"resource discovery fails", []stubRule{{Match: "get namespaces", Stdout: ns},
			{Match: "get --raw /apis/external-secrets.io/v1beta1", Exit: 1},
			{Match: "get --raw /apis", Stdout: `{"groups":[{"name":"external-secrets.io","preferredVersion":{"version":"v1beta1"}}]}`}}},
		{"resource discovery is not JSON", []stubRule{{Match: "get namespaces", Stdout: ns},
			{Match: "get --raw /apis/external-secrets.io/v1beta1", Stdout: "nope"},
			{Match: "get --raw /apis", Stdout: `{"groups":[{"name":"external-secrets.io","preferredVersion":{"version":"v1beta1"}}]}`}}},
		{"a resource name is not a path", []stubRule{{Match: "get namespaces", Stdout: ns},
			{Match: "get --raw /apis/external-secrets.io/v1beta1", Stdout: `{"resources":[{"name":"Bad Name","kind":"X","namespaced":true,"verbs":["list","delete"]}]}`},
			{Match: "get --raw /apis", Stdout: `{"groups":[{"name":"external-secrets.io","preferredVersion":{"version":"v1beta1"}}]}`}}},
		{"an object listing is not JSON", append([]stubRule{{Match: "get namespaces", Stdout: ns},
			{Match: "/namespaces/byo-pay/externalsecrets", Stdout: "nope"}}, sweepDiscovery(t)...)},
		{"a listed object has no usable uid", append([]stubRule{{Match: "get namespaces", Stdout: ns},
			{Match: "/namespaces/byo-pay/externalsecrets", Stdout: `{"items":[{"metadata":{"name":"x","namespace":"byo-pay","uid":"not-a-uid"}}]}`}}, sweepDiscovery(t)...)},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			stub := newKubectlStub(t, 0, append(c.rules, stubRule{Match: "/namespaces/", Stdout: emptyList})...)
			var stdout, stderr bytes.Buffer
			w := SweepByoSecretSyncObjects("env-1", nil, nil, &stdout, &stderr)
			if stub.calledWith("delete") || stub.calledWith("replace") || len(w) != 0 {
				t.Errorf("the sweep wrote after a failed read; calls: %v", stub.calls())
			}
			if !strings.Contains(stderr.String(), "not sweeping") {
				t.Errorf("the stopped sweep was not reported: %s", stderr.String())
			}
		})
	}
}

// TestSweepByoSecretSync_SkipsWhatItMustNotTouch: a resource that cannot be both listed and
// deleted is not swept, an object a listing places in another namespace is ignored, and a delete the
// API server refuses is logged without a Deploy-tab claim that it happened.
func TestSweepByoSecretSync_SkipsWhatItMustNotTouch(t *testing.T) {
	res := `{"resources":[{"name":"externalsecrets","kind":"ExternalSecret","namespaced":true,"verbs":["list","delete"]},` +
		`{"name":"readonlies","kind":"ReadOnly","namespaced":true,"verbs":["list"]}]}`
	stub := newKubectlStub(t, 0,
		stubRule{Match: "get namespaces", Stdout: sweepNS(t, map[string]map[string]string{"byo-pay": byoNSLabels("env-1")})},
		stubRule{Match: "delete --raw", Exit: 1},
		stubRule{Match: "/namespaces/byo-pay/externalsecrets", Stdout: `{"items":[` +
			`{"metadata":{"name":"elsewhere","namespace":"other","uid":"` + testUID + `"}},` +
			`{"metadata":{"name":"chart-made","namespace":"byo-pay","uid":"` + testUID + `"}}]}`},
		stubRule{Match: "get --raw /apis/external-secrets.io/v1beta1", Stdout: res},
		stubRule{Match: "get --raw /apis", Stdout: `{"groups":[{"name":"external-secrets.io","preferredVersion":{"version":"v1beta1"}}]}`},
	)
	var stdout, stderr bytes.Buffer
	w := SweepByoSecretSyncObjects("env-1", nil, nil, &stdout, &stderr)
	if stub.calledWith("readonlies") {
		t.Errorf("a resource without the delete verb was listed; calls: %v", stub.calls())
	}
	if stub.calledWith("/elsewhere ") {
		t.Errorf("an object outside the listed namespace was deleted; calls: %v", stub.calls())
	}
	if len(w) != 0 || !strings.Contains(stderr.String(), "failed to delete ExternalSecret byo-pay/chart-made") {
		t.Errorf("a refused delete was reported as done (%q) or not logged: %s", w, stderr.String())
	}
}

// TestByoRestoreBinding_RefusesWhatItCannotPin: a rendered document that does not parse, a live spec
// that does not parse, a listing without a resourceVersion, and a rendered document naming another
// object are each refused without a write.
func TestByoRestoreBinding_RefusesWhatItCannotPin(t *testing.T) {
	stub := newKubectlStub(t, 0)
	squatted, _ := json.Marshal(map[string]any{"dataFrom": []any{"x"}})
	base := byoSweepObject{namespace: "byo-pay", name: "api-db", uid: testUID, resourceVersion: "1", spec: squatted}
	noRV := base
	noRV.resourceVersion = ""
	badSpec := base
	badSpec.spec = json.RawMessage("nope")
	cases := []struct {
		name    string
		o       byoSweepObject
		doc     string
		warning bool
	}{
		{"rendered document does not parse", base, "a: [", false},
		{"live spec does not parse", badSpec, renderedBinding, false},
		{"no resourceVersion in the listing", noRV, renderedBinding, true},
		{"rendered document names another object", base, strings.Replace(renderedBinding, "name: api-db\n  namespace", "name: other\n  namespace", 1), true},
	}
	for _, c := range cases {
		var stdout, stderr bytes.Buffer
		w := byoRestoreBinding(c.o, c.doc, &stdout, &stderr)
		if (w != "") != c.warning || stderr.Len() == 0 {
			t.Errorf("%s: warning %q, stderr %q", c.name, w, stderr.String())
		}
	}
	if stub.calledWith("replace") {
		t.Errorf("a refused restore wrote; calls: %v", stub.calls())
	}
}

// TestByoBindingSpecMatches_Normalisation pins the comparison's edges: nothing rendered never
// matches, a spec without a target matches its defaulted form, a template gets its defaults, a
// non-object data entry and a null value compare as themselves.
func TestByoBindingSpecMatches_Normalisation(t *testing.T) {
	if byoBindingSpecMatches(map[string]any{}, nil) {
		t.Error("a live spec matched a document with no spec")
	}
	if !byoBindingSpecMatches(
		map[string]any{"target": map[string]any{"creationPolicy": "Owner", "deletionPolicy": "Retain"}, "refreshInterval": "1h"},
		map[string]any{},
	) {
		t.Error("a spec with no target did not match its defaulted form")
	}
	if !byoBindingSpecMatches(
		map[string]any{"target": map[string]any{"template": map[string]any{"engineVersion": "v2", "mergePolicy": "Replace", "data": map[string]any{"username": "u"}}}},
		map[string]any{"target": map[string]any{"template": map[string]any{"data": map[string]any{"username": "u"}}}},
	) {
		t.Error("a template did not match its defaulted form")
	}
	if !byoBindingSpecMatches(map[string]any{"data": []any{"odd", nil}}, map[string]any{"data": []any{"odd", nil}}) {
		t.Error("identical unusual data entries did not match")
	}
	if byoBindingSpecMatches(map[string]any{"data": []any{"odd"}}, map[string]any{"data": []any{"other"}}) {
		t.Error("different data entries matched")
	}
}
