// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure halves of the predicted-live probe — no cluster, so they run on every PR.
//
// The rule these tests exist to hold: this probe answers a question that has already been answered
// WRONG twice on #2717, both times by a confident verdict built on a mechanism nobody had measured.
// So every branch that could not ask must say COULD NOT ASK, and no branch may render a
// could-not-ask as "nothing differs". That is asserted here rather than left to review, because the
// two sentences are one word apart and a run costs real money to repeat.
package e2e

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestDescribeArgoDiffStrategySeparatesTheThreeCases(t *testing.T) {
	// The whole point of this note: on a ServerSideApply Application the controller and
	// `argocd app diff` run DIFFERENT algorithms, so an empty diff is not a contradiction. Without
	// ServerSideApply they run the same one, and then it is.
	ssa := describeArgoDiffStrategy(argoAppDiffStrategySpec{
		SyncOptions: []string{"CreateNamespace=true", "ServerSideApply=true", "RespectIgnoreDifferences=true"},
	}, "v9.9.9", nil)
	if !strings.Contains(ssa, "STRUCTURED-MERGE") {
		t.Fatalf("ServerSideApply without ServerSideDiff must name structured-merge diff, got %q", ssa)
	}
	if strings.Contains(ssa, "genuine contradiction") {
		t.Fatalf("ServerSideApply must NOT be reported as a contradiction: %q", ssa)
	}

	plain := describeArgoDiffStrategy(argoAppDiffStrategySpec{
		SyncOptions: []string{"CreateNamespace=true"},
	}, "v9.9.9", nil)
	if !strings.Contains(plain, "genuine contradiction") {
		t.Fatalf("without ServerSideApply an empty diff IS a contradiction, got %q", plain)
	}
	if strings.Contains(plain, "STRUCTURED-MERGE") {
		t.Fatalf("no ServerSideApply means no structured-merge diff: %q", plain)
	}

	ssd := describeArgoDiffStrategy(argoAppDiffStrategySpec{
		SyncOptions:    []string{"ServerSideApply=true"},
		CompareOptions: "ServerSideDiff=true",
	}, "v9.9.9", nil)
	if !strings.Contains(ssd, "dry-run apply") {
		t.Fatalf("ServerSideDiff=true must name the API-server dry-run, got %q", ssd)
	}
	if strings.Contains(ssd, "STRUCTURED-MERGE") {
		t.Fatalf("ServerSideDiff=true is not structured-merge: %q", ssd)
	}
}

func TestDescribeArgoDiffStrategyHonoursAnExplicitFalse(t *testing.T) {
	// `ServerSideDiff=false` disables it in argo-cd (controller/state.go checks both spellings), so
	// a substring match on "ServerSideDiff=true" alone would read the disabling annotation as
	// enabling. Both strings appear in `ServerSideDiff=false` only if you match carelessly.
	got := describeArgoDiffStrategy(argoAppDiffStrategySpec{
		SyncOptions:    []string{"ServerSideApply=true"},
		CompareOptions: "ServerSideDiff=false",
	}, "v9.9.9", nil)
	if !strings.Contains(got, "STRUCTURED-MERGE") {
		t.Fatalf("ServerSideDiff=false leaves structured-merge diff in place, got %q", got)
	}
}

func TestDescribeArgoDiffStrategyCannotInventAVerdict(t *testing.T) {
	got := describeArgoDiffStrategy(argoAppDiffStrategySpec{}, "v9.9.9", errors.New("connection refused"))
	if !strings.Contains(got, "COULD NOT ASK") {
		t.Fatalf("a read failure must render as COULD NOT ASK, got %q", got)
	}
	for _, forbidden := range []string{"STRUCTURED-MERGE", "genuine contradiction", "dry-run apply"} {
		if strings.Contains(got, forbidden) {
			t.Fatalf("a read failure leaked the verdict %q: %s", forbidden, got)
		}
	}
}

func TestParseArgoDiffStrategySpecReadsBothHalves(t *testing.T) {
	raw := []byte(`{
	  "metadata": {"annotations": {"argocd.argoproj.io/compare-options": "ServerSideDiff=true"}},
	  "spec": {"syncPolicy": {"syncOptions": ["ServerSideApply=true"]}}
	}`)
	got, err := parseArgoDiffStrategySpec(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(got.SyncOptions) != 1 || got.SyncOptions[0] != "ServerSideApply=true" {
		t.Fatalf("syncOptions not read: %+v", got)
	}
	if got.CompareOptions != "ServerSideDiff=true" {
		t.Fatalf("compare-options not read: %+v", got)
	}
	if _, err := parseArgoDiffStrategySpec([]byte("not json")); err == nil {
		t.Fatal("malformed JSON must be an error, not an empty spec that reads as 'no ServerSideApply'")
	}
}

func TestIndexAppliedObjectsHandlesBothKubectlShapes(t *testing.T) {
	// kubectl prints one JSON document per object, concatenated — and wraps them in a List on some
	// paths. Getting either wrong means the ref is never found and the probe says COULD NOT ASK on
	// a run that actually had the answer.
	stream := `{"apiVersion":"apps/v1","kind":"StatefulSet","metadata":{"name":"addon-loki","namespace":"monitoring"}}
{"apiVersion":"v1","kind":"Service","metadata":{"name":"addon-loki","namespace":"monitoring"}}`
	got, err := indexAppliedObjects([]byte(stream))
	if err != nil {
		t.Fatalf("concatenated stream: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("want 2 objects, got %d", len(got))
	}
	key := refManifestKey(outOfSyncRef{Group: "apps", Kind: "StatefulSet", Name: "addon-loki", Namespace: "monitoring"})
	if _, ok := got[key]; !ok {
		t.Fatalf("the StatefulSet ref did not match any applied object; keys=%v", keysOf(got))
	}
	// The core-group Service must NOT collide with the apps-group StatefulSet of the same name.
	svc := refManifestKey(outOfSyncRef{Group: "", Kind: "Service", Name: "addon-loki", Namespace: "monitoring"})
	if _, ok := got[svc]; !ok {
		t.Fatalf("the core-group Service ref did not match; keys=%v", keysOf(got))
	}

	list := `{"apiVersion":"v1","kind":"List","items":[
	  {"apiVersion":"batch/v1","kind":"CronJob","metadata":{"name":"kyverno-cleanup-admission-reports","namespace":"kyverno"}}]}`
	got, err = indexAppliedObjects([]byte(list))
	if err != nil {
		t.Fatalf("List shape: %v", err)
	}
	cj := refManifestKey(outOfSyncRef{Group: "batch", Kind: "CronJob", Name: "kyverno-cleanup-admission-reports", Namespace: "kyverno"})
	if _, ok := got[cj]; !ok {
		t.Fatalf("the CronJob inside a List was not unwrapped; keys=%v", keysOf(got))
	}
}

func TestIndexAppliedObjectsRefusesToReportEmptyAsSuccess(t *testing.T) {
	// "the dry-run produced nothing" and "the dry-run produced no difference" are opposite findings.
	// An empty map returned with a nil error would let the first render as the second.
	if _, err := indexAppliedObjects(nil); err == nil {
		t.Fatal("empty output must be an error")
	}
	if _, err := indexAppliedObjects([]byte("   \n ")); err == nil {
		t.Fatal("whitespace-only output must be an error")
	}
	if _, err := indexAppliedObjects([]byte("error: the server rejected the apply")); err == nil {
		t.Fatal("kubectl error text is not JSON and must be an error")
	}
	// A document with no name is not indexable, and indexing zero objects is still nothing.
	if _, err := indexAppliedObjects([]byte(`{"kind":"StatefulSet","metadata":{}}`)); err == nil {
		t.Fatal("a nameless object yields no index entry, which must read as an error")
	}
}

func TestPredictedLiveDifferencesNamesTheVolumeClaimTemplateFields(t *testing.T) {
	// The shape upstream argo-cd#11143 reports for `ServerSideApply=true` StatefulSets: the LIVE
	// volumeClaimTemplate carries apiVersion/kind/creationTimestamp/status/volumeMode that the
	// applied manifest never had. This is the exact output the probe exists to produce.
	predicted := decodeObj(t, `{
	  "apiVersion":"apps/v1","kind":"StatefulSet",
	  "metadata":{"name":"addon-loki","namespace":"monitoring"},
	  "spec":{"volumeClaimTemplates":[{"metadata":{"name":"storage"},
	    "spec":{"accessModes":["ReadWriteOnce"],"resources":{"requests":{"storage":"10Gi"}}}}]}}`)
	live := decodeObj(t, `{
	  "apiVersion":"apps/v1","kind":"StatefulSet",
	  "metadata":{"name":"addon-loki","namespace":"monitoring"},
	  "spec":{"volumeClaimTemplates":[{"apiVersion":"v1","kind":"PersistentVolumeClaim",
	    "metadata":{"name":"storage","creationTimestamp":null},
	    "spec":{"accessModes":["ReadWriteOnce"],"resources":{"requests":{"storage":"10Gi"}},"volumeMode":"Filesystem"},
	    "status":{"phase":"Pending"}}]}}`)

	got := strings.Join(predictedLiveDifferences(predicted, live), "\n")
	for _, want := range []string{
		"spec.volumeClaimTemplates[0].apiVersion",
		"spec.volumeClaimTemplates[0].kind",
		"spec.volumeClaimTemplates[0].metadata.creationTimestamp",
		"spec.volumeClaimTemplates[0].spec.volumeMode",
		"spec.volumeClaimTemplates[0].status",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("the differing field %q was not named:\n%s", want, got)
		}
	}
	if !strings.Contains(got, "absent from predicted") {
		t.Fatalf("a field present only in live must say which side lacks it:\n%s", got)
	}
}

func TestPredictedLiveDifferencesIgnoresTheVolatileFields(t *testing.T) {
	// resourceVersion, managedFields and the top-level status change between the dry-run and the
	// live read seconds later. Reporting them would manufacture a difference on EVERY resource and
	// bury the one that matters.
	predicted := decodeObj(t, `{"kind":"StatefulSet","metadata":{"name":"x","resourceVersion":"1",
	  "managedFields":[{"manager":"a"}],"generation":1,"uid":"u1","creationTimestamp":"2026-01-01T00:00:00Z"},
	  "status":{"replicas":1}}`)
	live := decodeObj(t, `{"kind":"StatefulSet","metadata":{"name":"x","resourceVersion":"999",
	  "managedFields":[{"manager":"b"}],"generation":7,"uid":"u2","creationTimestamp":"2026-02-02T00:00:00Z"},
	  "status":{"replicas":3}}`)
	if got := predictedLiveDifferences(predicted, live); len(got) != 0 {
		t.Fatalf("volatile fields must not be reported, got %v", got)
	}

	// …but the exclusion is TOP-LEVEL only. `spec.volumeClaimTemplates[].status` is the field
	// upstream names, and a blanket "status" match would silently drop it — which would make this
	// whole probe report nothing on exactly the case it was written for.
	p2 := decodeObj(t, `{"spec":{"volumeClaimTemplates":[{"metadata":{"name":"s"}}]}}`)
	l2 := decodeObj(t, `{"spec":{"volumeClaimTemplates":[{"metadata":{"name":"s"},"status":{"phase":"Pending"}}]}}`)
	if got := predictedLiveDifferences(p2, l2); len(got) != 1 || !strings.Contains(got[0], "volumeClaimTemplates[0].status") {
		t.Fatalf("a nested status must still be reported, got %v", got)
	}
}

func TestPredictedLiveDifferencesDoesNotInventNumericDrift(t *testing.T) {
	// Both decoders use UseNumber, so 1 and 1.0 must not read as a difference just because Go
	// widened them to float64 — a false line here is indistinguishable from the real finding.
	p := decodeObj(t, `{"spec":{"replicas":1,"minReadySeconds":0}}`)
	l := decodeObj(t, `{"spec":{"replicas":1,"minReadySeconds":0}}`)
	if got := predictedLiveDifferences(p, l); len(got) != 0 {
		t.Fatalf("identical numbers must not differ, got %v", got)
	}
	changed := decodeObj(t, `{"spec":{"replicas":2,"minReadySeconds":0}}`)
	if got := predictedLiveDifferences(p, changed); len(got) != 1 {
		t.Fatalf("a real numeric change must be reported once, got %v", got)
	}
}

func TestPredictedLiveDifferencesReportsListLengthRatherThanMisaligning(t *testing.T) {
	// Comparing item i to item i across lists of different lengths would report every element as
	// changed and name none of them usefully. Say the lengths instead.
	p := decodeObj(t, `{"spec":{"volumeClaimTemplates":[{"metadata":{"name":"a"}}]}}`)
	l := decodeObj(t, `{"spec":{"volumeClaimTemplates":[{"metadata":{"name":"a"}},{"metadata":{"name":"b"}}]}}`)
	got := predictedLiveDifferences(p, l)
	if len(got) != 1 || !strings.Contains(got[0], "predicted 1 item(s), live 2 item(s)") {
		t.Fatalf("a length mismatch must be reported as such, got %v", got)
	}
}

func TestRenderPredictedLiveDiffDistinguishesEmptyFromUnasked(t *testing.T) {
	// The empty case is a FINDING — a server-side comparison agrees with live — and it must read
	// differently from the COULD NOT ASK branches in argoPredictedLiveDiff.
	empty := renderPredictedLiveDiff("statefulset.apps/addon-loki", nil)
	if strings.Contains(empty, "COULD NOT ASK") {
		t.Fatalf("an empty diff is not a failure to ask: %q", empty)
	}
	if !strings.Contains(empty, "predicts the LIVE object EXACTLY") {
		t.Fatalf("the empty case must state what it found: %q", empty)
	}

	many := make([]string, 60)
	for i := range many {
		many[i] = "spec.x: predicted=1 live=2"
	}
	long := renderPredictedLiveDiff("statefulset.apps/x", many)
	if !strings.Contains(long, "… 20 more") {
		t.Fatalf("the cap must say how many it dropped: %q", long)
	}
	if !strings.Contains(long, "60 field(s) differ") {
		t.Fatalf("the cap must not hide the true count: %q", long)
	}
}

func TestArgoPredictedLiveDiffWithNoRefsDoesNotClaimToHaveLooked(t *testing.T) {
	// The only branch that runs no command at all. It must not read like "we compared and found
	// nothing" — that is the sentence this whole file exists to keep separate.
	got := argoPredictedLiveDiff(t.Context(), "/nonexistent-kubeconfig", "statefulset.apps/c", "addon-loki", nil)
	if !strings.Contains(got, "names no OutOfSync resource") {
		t.Fatalf("want the no-refs finding, got %q", got)
	}
	if strings.Contains(got, "EXACTLY") || strings.Contains(got, "field(s) differ") {
		t.Fatalf("the no-refs branch leaked a comparison verdict: %q", got)
	}
}

func TestReadArgoDiffStrategyWithoutAClusterSaysSoRatherThanGuessing(t *testing.T) {
	// No cluster: kubectl either is absent or cannot reach one. Both are "could not ask", and the
	// dangerous failure would be falling through to the `!ssa` branch — which asserts the two
	// diffs are the SAME comparison and that the empty diff is therefore a real contradiction.
	got := readArgoDiffStrategy(t.Context(), "/nonexistent-kubeconfig", "statefulset.apps/argo-cd-argocd-application-controller", "addon-loki")
	if !strings.Contains(got, "COULD NOT ASK") {
		t.Fatalf("want COULD NOT ASK without a cluster, got %q", got)
	}
	if strings.Contains(got, "genuine contradiction") {
		t.Fatalf("an unreachable cluster must not read as 'the two diffs agree': %q", got)
	}
}

func TestArgoPredictedLiveDiffWithoutAClusterSaysSoRatherThanGuessing(t *testing.T) {
	// With refs present but no cluster, the FIRST exec fails. The branch must name the failure and
	// must not produce either comparison verdict.
	got := argoPredictedLiveDiff(t.Context(), "/nonexistent-kubeconfig", "statefulset.apps/c", "addon-loki",
		[]outOfSyncRef{{Group: "apps", Kind: "StatefulSet", Name: "addon-loki", Namespace: "monitoring"}})
	if !strings.Contains(got, "COULD NOT ASK") {
		t.Fatalf("want COULD NOT ASK without a cluster, got %q", got)
	}
	if strings.Contains(got, "EXACTLY") || strings.Contains(got, "field(s) differ") {
		t.Fatalf("a failure to ask leaked a comparison verdict: %q", got)
	}
	if !strings.Contains(got, "says NOTHING about whether a field differs") {
		t.Fatalf("the failure must state what it does NOT decide: %q", got)
	}
}

func TestReadLiveObjectWithoutAClusterErrors(t *testing.T) {
	// Its caller renders an error as COULD NOT ASK; a nil error with a nil object would render as
	// an empty live document and then as "every field is absent from live", which is a fabricated
	// diff of the worst kind — it names fields.
	if _, err := readLiveObject(t.Context(), "/nonexistent-kubeconfig",
		outOfSyncRef{Group: "apps", Kind: "StatefulSet", Name: "addon-loki", Namespace: "monitoring"}); err == nil {
		t.Fatal("want an error reading a live object with no cluster")
	}
}

func TestRefManifestKeyMatchesManifestKeyForBothGroupShapes(t *testing.T) {
	if got, want := manifestKey("apps/v1", "StatefulSet", "monitoring", "addon-loki"),
		refManifestKey(outOfSyncRef{Group: "apps", Kind: "StatefulSet", Namespace: "monitoring", Name: "addon-loki"}); got != want {
		t.Fatalf("grouped kinds must match: %q vs %q", got, want)
	}
	if got, want := manifestKey("v1", "Service", "monitoring", "addon-loki"),
		refManifestKey(outOfSyncRef{Group: "", Kind: "Service", Namespace: "monitoring", Name: "addon-loki"}); got != want {
		t.Fatalf("core-group kinds must match: %q vs %q", got, want)
	}
}

// decodeObj decodes a JSON literal the same way the probe decodes cluster output — UseNumber, so
// the fixtures exercise the same number handling the real path does.
func decodeObj(t *testing.T, raw string) map[string]any {
	t.Helper()
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.UseNumber()
	var obj map[string]any
	if err := dec.Decode(&obj); err != nil {
		t.Fatalf("fixture is not valid JSON: %v", err)
	}
	return obj
}

func keysOf(m map[string]map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
