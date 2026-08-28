// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure half of the ServerSideDiff experiment — no cluster, so it runs on every PR.
//
// THE RULE THIS FILE ENFORCES. The experiment has exactly three answers and the third is not a
// weaker version of the other two: FLIP WOULD FIX IT, FLIP WOULD NOT FIX IT, COULD NOT ASK. #2717
// has already been answered wrong twice from evidence that did not carry the answer, so every way
// the experiment can fail to run — a failed patch, a status the controller never recomputed, a
// spec that moved, a sync that landed in the window — must render as COULD NOT ASK and must be
// impossible to mistake for either verdict.
//
// The second rule: the Application must be put back. describeSSDRestore's failure branches are
// pinned here because a silently modified Application would make every LATER assertion in the run
// describe the experiment rather than the shipped configuration.
package e2e

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
)

// ssdSpecFixture is one add-on Application's `.spec`, canonicalised the way parseSSDSnapshot
// canonicalises a real one — so the tests compare the same kind of value the live path does.
func ssdSpecFixture(t *testing.T, raw string) (string, bool) {
	t.Helper()
	canonical, err := ssdCanonicalJSON([]byte(raw))
	if err != nil {
		t.Fatalf("the fixture spec must be valid JSON: %v", err)
	}
	return canonical, true
}

// ssdAddonSpec is a plausible add-on Application spec, close enough in shape to the real thing that
// a path named in a diff reads like one a maintainer would go and look at.
const ssdAddonSpec = `{
  "project": "default",
  "destination": {"server": "https://kubernetes.default.svc", "namespace": "observability"},
  "source": {
    "repoURL": "https://grafana.github.io/helm-charts",
    "chart": "tempo",
    "targetRevision": "1.23.2",
    "helm": {"valuesObject": {"replicas": 1}}
  },
  "syncPolicy": {
    "automated": {"selfHeal": true, "prune": false},
    "syncOptions": ["ServerSideApply=true", "RespectIgnoreDifferences=true"]
  }
}`

// ssdObs builds an observation that differs from a clean one only in what a test varies. The
// default is a well-formed window: the settle reconcile is strictly after the pre-flip read, the
// verdict reconcile is strictly after the settle, the generation is unchanged, the `.spec` content
// is the same on both reads, and no sync operation ran.
func ssdObs(t *testing.T, afterSync string) ssdObservation {
	t.Helper()
	spec, hasSpec := ssdSpecFixture(t, ssdAddonSpec)
	return ssdObservation{
		App: "addon-tempo",
		Before: ssdSnapshot{
			Generation:         7,
			Spec:               spec,
			HasSpec:            hasSpec,
			Sync:               "OutOfSync",
			ReconciledAt:       "2026-08-28T13:49:00Z",
			OperationStartedAt: "2026-08-28T13:20:00Z",
		},
		Settle: ssdSnapshot{
			Generation:         7,
			Spec:               spec,
			HasSpec:            hasSpec,
			Sync:               "OutOfSync",
			ReconciledAt:       "2026-08-28T13:49:40Z",
			OperationStartedAt: "2026-08-28T13:20:00Z",
		},
		After: ssdSnapshot{
			Generation:         7,
			Spec:               spec,
			HasSpec:            hasSpec,
			Sync:               afterSync,
			ReconciledAt:       "2026-08-28T13:50:12Z",
			OperationStartedAt: "2026-08-28T13:20:00Z",
		},
	}
}

// assertOneVerdict is the whole point of the file: the three verdicts are mutually exclusive, so a
// report may carry exactly one of them.
func assertOneVerdict(t *testing.T, got, want string) {
	t.Helper()
	verdicts := []string{"FLIP WOULD FIX IT", "FLIP WOULD NOT FIX IT", "COULD NOT ASK"}
	for _, v := range verdicts {
		has := strings.Contains(got, v)
		if v == want && !has {
			t.Fatalf("expected the verdict %q, got %q", want, got)
		}
		if v != want && has {
			t.Fatalf("verdict %q must not appear alongside %q: %q", v, want, got)
		}
	}
}

func TestSSDExperimentFlipWouldFixIt(t *testing.T) {
	got := describeSSDExperiment(ssdObs(t, "Synced"))
	assertOneVerdict(t, got, "FLIP WOULD FIX IT")
	if !strings.Contains(got, "addon-tempo") {
		t.Fatalf("the verdict must name the Application it was measured on: %q", got)
	}
	if !strings.Contains(got, "NO sync operation in the window") {
		t.Fatalf("the alternative explanation must be excluded IN THE TEXT, not silently: %q", got)
	}
}

func TestSSDExperimentFlipWouldNotFixIt(t *testing.T) {
	got := describeSSDExperiment(ssdObs(t, "OutOfSync"))
	// "FLIP WOULD NOT FIX IT" contains neither of the other two verdict strings, and this is the
	// assertion that keeps it that way if the wording is ever edited.
	assertOneVerdict(t, got, "FLIP WOULD NOT FIX IT")
	if !strings.Contains(got, "STILL OutOfSync") {
		t.Fatalf("the negative verdict must say what was observed: %q", got)
	}
}

func TestSSDExperimentCannotAskWhenTheQuestionCouldNotBePut(t *testing.T) {
	obs := ssdObs(t, "Synced")
	obs.AskErr = errors.New("kubectl patch addon-tempo: exit status 1: applications.argoproj.io \"addon-tempo\" not found")
	got := describeSSDExperiment(obs)
	// The trap: the After snapshot says Synced. If AskErr were checked anywhere but first, a failed
	// experiment would report the flip as a fix on a status the flip never touched.
	assertOneVerdict(t, got, "COULD NOT ASK")
	if !strings.Contains(got, "not found") {
		t.Fatalf("the reason must survive into the report, or the branch is unactionable: %q", got)
	}
}

func TestSSDExperimentCannotAskWithoutAPostFlipReconcile(t *testing.T) {
	// THE defect this probe is most likely to have: reading a verdict off the pre-flip status.
	// Every one of these is a status that is NOT provably later than the flip.
	for name, mutate := range map[string]func(*ssdObservation){
		"no reconcile at all after the flip": func(o *ssdObservation) {
			o.Settle.ReconciledAt = o.Before.ReconciledAt
			o.After.ReconciledAt = o.Before.ReconciledAt
		},
		"settle reconcile went backwards": func(o *ssdObservation) {
			o.Settle.ReconciledAt = "2026-08-28T13:48:00Z"
		},
		// THE false negative the three-read chain exists for: exactly one reconcile landed after
		// the patch, and it may have been the one already in flight when the annotation was
		// written — a comparison made with the OLD compare-options.
		"only the possibly-in-flight reconcile landed": func(o *ssdObservation) {
			o.After = o.Settle
		},
		"confirming reconcile went backwards": func(o *ssdObservation) {
			o.After.ReconciledAt = "2026-08-28T13:49:20Z"
		},
		"reconciledAt missing after":   func(o *ssdObservation) { o.After.ReconciledAt = "" },
		"reconciledAt missing settle":  func(o *ssdObservation) { o.Settle.ReconciledAt = "" },
		"reconciledAt missing before":  func(o *ssdObservation) { o.Before.ReconciledAt = "" },
		"reconciledAt unparseable":     func(o *ssdObservation) { o.After.ReconciledAt = "just now" },
		"settle reconciledAt garbaged": func(o *ssdObservation) { o.Settle.ReconciledAt = "soon" },
	} {
		t.Run(name, func(t *testing.T) {
			// Synced on purpose: the stale status carries the verdict a reader most wants.
			obs := ssdObs(t, "Synced")
			mutate(&obs)
			assertOneVerdict(t, describeSSDExperiment(obs), "COULD NOT ASK")
		})
	}
}

// TestSSDExperimentRun33185250586WouldNowProduceAVerdict is the regression test for the whole
// refinement, and the evidence that a fourth run is worth paying for.
//
// Every figure below is transcribed from run 33185250586's own `[freshness]` lines, not invented:
// both subjects moved the generation by EXACTLY +2 in a window in which the experiment forces
// EXACTLY two reconciles, both reconcile chains are strictly ordered, `operationState.startedAt`
// did NOT move on either (so no selfHeal can be credited), and both went OutOfSync → Synced under
// the flip. The old gate refused both because the COUNTER moved — the third inconclusive run on
// #2717 — with the answer sitting in the line that reported the refusal.
//
// Nothing re-applied these Applications: they are kubectl-applied once per deploy and have no
// app-of-apps parent, so the spec content is held equal here for the reason it was equal there.
func TestSSDExperimentRun33185250586WouldNowProduceAVerdict(t *testing.T) {
	spec, hasSpec := ssdSpecFixture(t, ssdAddonSpec)
	snap := func(generation int64, sync, reconciledAt, operationStartedAt string) ssdSnapshot {
		return ssdSnapshot{
			Generation: generation, Spec: spec, HasSpec: hasSpec,
			Sync: sync, ReconciledAt: reconciledAt, OperationStartedAt: operationStartedAt,
		}
	}
	for _, tc := range []struct {
		app                           string
		before, settle, after         int64
		beforeAt, settleAt, verdictAt string
		operationAt                   string
	}{
		// [freshness] metadata.generation 83→85 · status.reconciledAt 16:36:40 → 16:37:03 (settle)
		// → 16:37:05 · status.sync.status OutOfSync→Synced · operationState.startedAt 16:34:47 (unmoved)
		{"addon-tempo", 83, 84, 85,
			"2026-08-28T16:36:40Z", "2026-08-28T16:37:03Z", "2026-08-28T16:37:05Z", "2026-08-28T16:34:47Z"},
		// [freshness] metadata.generation 91→93 · status.reconciledAt 16:36:24 → 16:37:09 (settle)
		// → 16:37:10 · status.sync.status OutOfSync→Synced · operationState.startedAt 16:34:25 (unmoved)
		{"addon-harbor", 91, 92, 93,
			"2026-08-28T16:36:24Z", "2026-08-28T16:37:09Z", "2026-08-28T16:37:10Z", "2026-08-28T16:34:25Z"},
	} {
		t.Run(tc.app, func(t *testing.T) {
			got := describeSSDExperiment(ssdObservation{
				App:    tc.app,
				Before: snap(tc.before, "OutOfSync", tc.beforeAt, tc.operationAt),
				// The counter had already moved by the settle read: the settle reconcile itself wrote
				// a status, and on this CRD a status write bumps the generation.
				Settle: snap(tc.settle, "OutOfSync", tc.settleAt, tc.operationAt),
				After:  snap(tc.after, "Synced", tc.verdictAt, tc.operationAt),
			})
			assertOneVerdict(t, got, "FLIP WOULD FIX IT")
			// The bump must be DISCLOSED, not quietly dropped: a reader who remembers the old refusal
			// has to be told the counter moved and why that no longer disqualifies the window.
			for _, want := range []string{"metadata.generation DID move", "NO sync operation in the window", tc.app} {
				if !strings.Contains(got, want) {
					t.Fatalf("a verdict reached over a generation bump must disclose it (%s): %q", want, got)
				}
			}
			if !strings.Contains(got, "content UNCHANGED") {
				t.Fatalf("the freshness line must state the gate that was actually applied: %q", got)
			}
		})
	}
}

func TestSSDExperimentCannotAskWhenTheSPECCONTENTMovedUnderIt(t *testing.T) {
	// The confounder the gate is FOR: something re-applied a genuinely different desired state — a
	// redeploy, a hand edit — so the controller was not comparing the same thing before and after.
	obs := ssdObs(t, "Synced")
	changed, hasSpec := ssdSpecFixture(t, strings.Replace(ssdAddonSpec, `"targetRevision": "1.23.2"`, `"targetRevision": "1.24.0"`, 1))
	obs.After.Spec, obs.After.HasSpec = changed, hasSpec
	obs.After.Generation = obs.Before.Generation + 2
	got := describeSSDExperiment(obs)
	assertOneVerdict(t, got, "COULD NOT ASK")
	// Naming the path is the point of the branch. "the spec moved" tells the next reader to guess.
	for _, want := range []string{"spec.source.targetRevision", "1.23.2", "1.24.0"} {
		if !strings.Contains(got, want) {
			t.Fatalf("the disqualifying difference must be NAMED (%s): %q", want, got)
		}
	}
}

func TestSSDExperimentGenerationIsNotTheGateInEitherDirection(t *testing.T) {
	// The mirror of the fixture above: the counter is static and the content still differs. If the
	// generation were the gate — even as a shortcut that skips the content check when it has not
	// moved — this window would sail through and a spec change would be credited to the flip.
	obs := ssdObs(t, "Synced")
	changed, hasSpec := ssdSpecFixture(t, strings.Replace(ssdAddonSpec, `"replicas": 1`, `"replicas": 3`, 1))
	obs.After.Spec, obs.After.HasSpec = changed, hasSpec
	if obs.After.Generation != obs.Before.Generation {
		t.Fatalf("this test is only meaningful with a static generation: %d vs %d", obs.Before.Generation, obs.After.Generation)
	}
	got := describeSSDExperiment(obs)
	assertOneVerdict(t, got, "COULD NOT ASK")
	if !strings.Contains(got, "spec.source.helm.valuesObject.replicas") {
		t.Fatalf("the differing path must be named even when the counter did not move: %q", got)
	}
}

func TestSSDExperimentCannotAskWhenTheSpecMovedAndMovedBack(t *testing.T) {
	// The hole a first-and-last comparison cannot see: the spec was different at the settle read and
	// identical again by the verdict read, so Before == After while the controller compared
	// something else in between. The mid-window read is the only thing that catches it.
	obs := ssdObs(t, "Synced")
	changed, hasSpec := ssdSpecFixture(t, strings.Replace(ssdAddonSpec, `"chart": "tempo"`, `"chart": "tempo-distributed"`, 1))
	obs.Settle.Spec, obs.Settle.HasSpec = changed, hasSpec
	if obs.Before.Spec != obs.After.Spec {
		t.Fatal("this test is only meaningful when the first and last reads AGREE")
	}
	got := describeSSDExperiment(obs)
	assertOneVerdict(t, got, "COULD NOT ASK")
	if !strings.Contains(got, "spec.source.chart") {
		t.Fatalf("the mid-window difference must be named: %q", got)
	}
	if !strings.Contains(got, "settle") {
		t.Fatalf("the report must say WHICH read disagreed: %q", got)
	}
}

func TestSSDExperimentCannotAskWhenTheSpecWasNotRead(t *testing.T) {
	// Two unread specs compare EQUAL as strings. Without HasSpec that is a clean window on no
	// evidence at all — the "nothing found reads as nothing wrong" defect, in the one gate that
	// decides whether a verdict may be reported.
	for name, mutate := range map[string]func(*ssdObservation){
		"neither side read": func(o *ssdObservation) {
			o.Before.Spec, o.Before.HasSpec = "", false
			o.After.Spec, o.After.HasSpec = "", false
		},
		"before not read": func(o *ssdObservation) { o.Before.Spec, o.Before.HasSpec = "", false },
		"after not read":  func(o *ssdObservation) { o.After.Spec, o.After.HasSpec = "", false },
		"settle not read": func(o *ssdObservation) { o.Settle.Spec, o.Settle.HasSpec = "", false },
	} {
		t.Run(name, func(t *testing.T) {
			obs := ssdObs(t, "Synced")
			mutate(&obs)
			got := describeSSDExperiment(obs)
			assertOneVerdict(t, got, "COULD NOT ASK")
			if !strings.Contains(got, "NOT READ") {
				t.Fatalf("the freshness line must say the gate could not be applied: %q", got)
			}
		})
	}
}

func TestSSDExperimentKeyOrderIsNotASpecChange(t *testing.T) {
	// The normalisation the refinement turns on. A re-apply that serialises the same fields in a
	// different order must not read as a spec change, or the gate is a byte diff wearing a
	// semantic label.
	reordered, hasSpec := ssdSpecFixture(t, `{
	  "syncPolicy": {
	    "syncOptions": ["ServerSideApply=true", "RespectIgnoreDifferences=true"],
	    "automated": {"prune": false, "selfHeal": true}
	  },
	  "source": {
	    "targetRevision": "1.23.2",
	    "helm": {"valuesObject": {"replicas": 1}},
	    "chart": "tempo",
	    "repoURL": "https://grafana.github.io/helm-charts"
	  },
	  "destination": {"namespace": "observability", "server": "https://kubernetes.default.svc"},
	  "project": "default"
	}`)
	obs := ssdObs(t, "Synced")
	obs.After.Spec, obs.After.HasSpec = reordered, hasSpec
	obs.After.Generation = obs.Before.Generation + 1
	assertOneVerdict(t, describeSSDExperiment(obs), "FLIP WOULD FIX IT")
}

func TestSSDExperimentArrayOrderISASpecChange(t *testing.T) {
	// The other half of the same rule, and the reason canonicalisation stops at map keys: order is
	// semantic in an Application spec, so a reordered list is a real difference and must disqualify.
	reordered, hasSpec := ssdSpecFixture(t, strings.Replace(ssdAddonSpec,
		`["ServerSideApply=true", "RespectIgnoreDifferences=true"]`,
		`["RespectIgnoreDifferences=true", "ServerSideApply=true"]`, 1))
	obs := ssdObs(t, "Synced")
	obs.After.Spec, obs.After.HasSpec = reordered, hasSpec
	got := describeSSDExperiment(obs)
	assertOneVerdict(t, got, "COULD NOT ASK")
	if !strings.Contains(got, "spec.syncPolicy.syncOptions[0]") {
		t.Fatalf("the differing element must be named by index: %q", got)
	}
}

func TestSSDSpecDiffPathsNamesEveryShapeOfDifference(t *testing.T) {
	for name, tc := range map[string]struct {
		before, after string
		want          string
	}{
		"added key":      {`{"a":1}`, `{"a":1,"b":2}`, "spec.b (added: 2)"},
		"removed key":    {`{"a":1,"b":2}`, `{"a":1}`, "spec.b (removed)"},
		"changed scalar": {`{"a":"x"}`, `{"a":"y"}`, `spec.a ("x" → "y")`},
		"nested scalar":  {`{"a":{"b":{"c":1}}}`, `{"a":{"b":{"c":2}}}`, "spec.a.b.c (1 → 2)"},
		"list length":    {`{"a":[1,2]}`, `{"a":[1,2,3]}`, "spec.a (2 → 3 entries)"},
		"list element":   {`{"a":["x","y"]}`, `{"a":["x","z"]}`, `spec.a[1] ("y" → "z")`},
		"type changed":   {`{"a":"1"}`, `{"a":1}`, `spec.a ("1" → 1)`},
	} {
		t.Run(name, func(t *testing.T) {
			before, _ := ssdSpecFixture(t, tc.before)
			after, _ := ssdSpecFixture(t, tc.after)
			got := ssdSpecDiffPaths(before, after)
			if len(got) == 0 {
				t.Fatalf("two differing specs must yield at least one path")
			}
			if !strings.Contains(strings.Join(got, " · "), tc.want) {
				t.Fatalf("want %q among %v", tc.want, got)
			}
		})
	}
}

func TestSSDSpecDiffPathsIsEmptyOnlyForIdenticalSpecs(t *testing.T) {
	same, _ := ssdSpecFixture(t, ssdAddonSpec)
	if got := ssdSpecDiffPaths(same, same); len(got) != 0 {
		t.Fatalf("identical specs must produce no paths, got %v", got)
	}
	// A differ that returns nothing for two DIFFERENT inputs reads exactly like one that found
	// nothing wrong, which is how a gate reports green on what it could not examine.
	if got := ssdSpecDiffPaths("{not json", "{also not json"); len(got) == 0 {
		t.Fatal("an unlocatable difference must still be reported as a difference")
	}
}

func TestSSDSpecDiffPathsIsBounded(t *testing.T) {
	// A wholesale replacement must not print the entire object into a run log.
	var before, after strings.Builder
	before.WriteString("{")
	after.WriteString("{")
	for i := range 40 {
		if i > 0 {
			before.WriteString(",")
			after.WriteString(",")
		}
		fmt.Fprintf(&before, `"k%02d":%d`, i, i)
		fmt.Fprintf(&after, `"k%02d":%d`, i, i+1)
	}
	before.WriteString("}")
	after.WriteString("}")
	b, _ := ssdSpecFixture(t, before.String())
	a, _ := ssdSpecFixture(t, after.String())
	if got := ssdSpecDiffPaths(b, a); len(got) != maxSSDSpecDiffPaths {
		t.Fatalf("the path list must be capped at %d, got %d: %v", maxSSDSpecDiffPaths, len(got), got)
	}
}

func TestSSDCanonicalJSONKeepsLargeIntegersVerbatim(t *testing.T) {
	// Decoding through float64 would round this, and the gate would report a spec change it invented.
	got, err := ssdCanonicalJSON([]byte(`{"n":12345678901234567890}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(got, "12345678901234567890") {
		t.Fatalf("a large integer must survive canonicalisation verbatim: %q", got)
	}
}

func TestSSDExperimentCannotCreditTheFlipForASync(t *testing.T) {
	// These add-ons run automated sync with selfHeal, so a heal landing inside the window is a real
	// alternative explanation for Synced. Crediting the flip for it would be the same class of
	// error as reading a stale status.
	obs := ssdObs(t, "Synced")
	obs.After.OperationStartedAt = "2026-08-28T13:49:40Z"
	got := describeSSDExperiment(obs)
	assertOneVerdict(t, got, "COULD NOT ASK")
	if !strings.Contains(got, "SYNC OPERATION") {
		t.Fatalf("the confounder must be named: %q", got)
	}
}

func TestSSDExperimentASyncInTheWindowDoesNotSoftenTheNegative(t *testing.T) {
	// The asymmetry is deliberate and worth pinning: a selfHeal landing in the window cannot explain
	// a status that is STILL OutOfSync, so it must not downgrade that verdict.
	obs := ssdObs(t, "OutOfSync")
	obs.After.OperationStartedAt = "2026-08-28T13:49:40Z"
	assertOneVerdict(t, describeSSDExperiment(obs), "FLIP WOULD NOT FIX IT")

	// And the same holds when the controller.s own status writes bumped the counter over the top of
	// it: neither a heal nor a generation bump turns a still-OutOfSync into anything but the negative.
	obs.After.Generation = obs.Before.Generation + 2
	assertOneVerdict(t, describeSSDExperiment(obs), "FLIP WOULD NOT FIX IT")
}

func TestSSDExperimentUnknownStatusIsNotAVerdict(t *testing.T) {
	for _, status := range []string{"", "Unknown", "Progressing"} {
		assertOneVerdict(t, describeSSDExperiment(ssdObs(t, status)), "COULD NOT ASK")
	}
}

func TestSSDExperimentAlwaysReportsFreshness(t *testing.T) {
	// Including on the could-not-ask paths. The numbers that would reveal a misread verdict must
	// not be the thing omitted when the probe is unsure.
	obs := ssdObs(t, "Synced")
	obs.AskErr = errors.New("boom")
	for _, o := range []ssdObservation{ssdObs(t, "Synced"), ssdObs(t, "OutOfSync"), obs} {
		got := describeSSDExperiment(o)
		for _, want := range []string{"metadata.generation", "status.reconciledAt", "status.operationState.startedAt"} {
			if !strings.Contains(got, want) {
				t.Fatalf("every verdict must carry %s: %q", want, got)
			}
		}
	}
}

func TestSSDExperimentFreshnessShowsTheWholeChain(t *testing.T) {
	// All three reconcile timestamps, in order, so a reader can check the attribution argument
	// rather than take it on trust.
	got := describeSSDExperiment(ssdObs(t, "Synced"))
	for _, want := range []string{"2026-08-28T13:49:00Z", "2026-08-28T13:49:40Z", "2026-08-28T13:50:12Z", "(settle)"} {
		if !strings.Contains(got, want) {
			t.Fatalf("the freshness line must carry %s: %q", want, got)
		}
	}
}

func TestSSDExperimentFreshnessRendersAbsentTimestamps(t *testing.T) {
	got := describeSSDExperiment(ssdObservation{App: "addon-keda"})
	if !strings.Contains(got, "(none)") {
		t.Fatalf("an absent timestamp must render as (none), not as a gap in the line: %q", got)
	}
}

func TestParseSSDSnapshotReadsWhatTheExperimentNeeds(t *testing.T) {
	raw := []byte(`{
	  "metadata": {
	    "generation": 4,
	    "annotations": {
	      "argocd.argoproj.io/sync-wave": "2",
	      "argocd.argoproj.io/compare-options": "IgnoreExtraneous"
	    }
	  },
	  "spec": {"project": "default", "destination": {"namespace": "observability"}},
	  "status": {
	    "reconciledAt": "2026-08-28T13:49:26Z",
	    "sync": {"status": "OutOfSync"},
	    "operationState": {"startedAt": "2026-08-28T13:20:00Z"}
	  }
	}`)
	got, err := parseSSDSnapshot(raw)
	if err != nil {
		t.Fatalf("well-formed Application must parse: %v", err)
	}
	want := ssdSnapshot{
		CompareOptions:     "IgnoreExtraneous",
		HasCompareOptions:  true,
		Generation:         4,
		Spec:               `{"destination":{"namespace":"observability"},"project":"default"}`,
		HasSpec:            true,
		Sync:               "OutOfSync",
		ReconciledAt:       "2026-08-28T13:49:26Z",
		OperationStartedAt: "2026-08-28T13:20:00Z",
	}
	if got != want {
		t.Fatalf("snapshot mismatch:\n got %+v\nwant %+v", got, want)
	}
}

func TestParseSSDSnapshotCanonicalisesTheSpecItReads(t *testing.T) {
	// Two serialisations of the same desired state must produce the SAME snapshot field, because
	// that string equality is the attribution gate.
	a, err := parseSSDSnapshot([]byte(`{"spec":{"project":"default","source":{"chart":"tempo","repoURL":"u"}}}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	b, err := parseSSDSnapshot([]byte(`{"spec":{"source":{"repoURL":"u","chart":"tempo"},"project":"default"}}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !a.HasSpec || a.Spec != b.Spec {
		t.Fatalf("key order must not survive canonicalisation:\n %q\n %q", a.Spec, b.Spec)
	}
}

func TestParseSSDSnapshotDistinguishesAnAbsentSpecFromAnEmptyOne(t *testing.T) {
	// An Application with no `.spec` at all must NOT read as one whose spec is empty — two of those
	// compare equal and would pass the attribution gate on no evidence.
	absent, err := parseSSDSnapshot([]byte(`{"metadata":{"generation":1}}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if absent.HasSpec {
		t.Fatalf("a missing .spec must read as absent: %+v", absent)
	}
	empty, err := parseSSDSnapshot([]byte(`{"spec":{}}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !empty.HasSpec || empty.Spec != "{}" {
		t.Fatalf("an empty .spec must read as PRESENT: %+v", empty)
	}
	// `spec: null` is the apiserver saying there is nothing there, not an empty object.
	null, err := parseSSDSnapshot([]byte(`{"spec":null}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if null.HasSpec {
		t.Fatalf("a null .spec must read as absent: %+v", null)
	}
}

func TestParseSSDSnapshotDistinguishesAbsentFromEmpty(t *testing.T) {
	// This is the difference between restoring by DELETING the key and restoring by writing an
	// empty string, so it may not collapse.
	absent, err := parseSSDSnapshot([]byte(`{"metadata":{"annotations":{"a":"b"}}}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if absent.HasCompareOptions {
		t.Fatalf("an annotation that is not there must read as absent: %+v", absent)
	}
	empty, err := parseSSDSnapshot([]byte(`{"metadata":{"annotations":{"argocd.argoproj.io/compare-options":""}}}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !empty.HasCompareOptions || empty.CompareOptions != "" {
		t.Fatalf("an annotation set to the empty string must read as present: %+v", empty)
	}
}

func TestParseSSDSnapshotRejectsGarbage(t *testing.T) {
	if _, err := parseSSDSnapshot([]byte("Error from server (NotFound)")); err == nil {
		t.Fatal("a non-JSON response must be an error, not an empty snapshot that reads as a clean Application")
	}
}

// ssdPatchAnnotations decodes a rendered patch back to its annotation map, so the tests assert on
// the SHAPE the apiserver will see rather than on a substring of the JSON.
func ssdPatchAnnotations(t *testing.T, patch string) map[string]*string {
	t.Helper()
	var decoded ssdAnnotationPatch
	if err := json.Unmarshal([]byte(patch), &decoded); err != nil {
		t.Fatalf("the patch must be valid JSON: %v (%s)", err, patch)
	}
	return decoded.Metadata.Annotations
}

func TestSSDEnablePatchSetsTheOptionAndAsksForARecompare(t *testing.T) {
	ann := ssdPatchAnnotations(t, ssdEnablePatch())
	if got := ann[ssdCompareOptionsAnnotation]; got == nil || *got != ssdCompareOption {
		t.Fatalf("the enable patch must set the compare-option: %+v", ann)
	}
	// Without the refresh the experiment waits out a reconcile cadence and times out into COULD
	// NOT ASK on every run — which is the noise this file replaced.
	if got := ann[argoRefreshAnnotation]; got == nil || *got != argoRefreshNormal {
		t.Fatalf("the enable patch must request a re-compare: %+v", ann)
	}
}

func TestSSDRefreshPatchTouchesNothingButTheRefresh(t *testing.T) {
	// Re-writing the compare-option here would produce a new object version, and the confirming
	// comparison would then be the one THIS patch caused rather than one that provably followed the
	// flip — which is the whole attribution the second read buys.
	ann := ssdPatchAnnotations(t, ssdRefreshPatch())
	if got := ann[argoRefreshAnnotation]; got == nil || *got != argoRefreshNormal {
		t.Fatalf("the refresh patch must request a re-compare: %+v", ann)
	}
	if _, present := ann[ssdCompareOptionsAnnotation]; present {
		t.Fatalf("the refresh patch must not mention the compare-option at all: %+v", ann)
	}
}

func TestSSDRestorePatchDeletesAnAnnotationThatWasAbsent(t *testing.T) {
	ann := ssdPatchAnnotations(t, ssdRestorePatch(ssdSnapshot{}))
	value, present := ann[ssdCompareOptionsAnnotation]
	if !present {
		t.Fatalf("the key must be PRESENT and null — omitting it leaves the annotation in place: %+v", ann)
	}
	if value != nil {
		t.Fatalf("a JSON merge patch deletes a key by setting it to null, got %q", *value)
	}
	if got := ann[argoRefreshAnnotation]; got == nil || *got != argoRefreshNormal {
		t.Fatalf("the restore must also request a re-compare, or the run keeps measuring the experiment: %+v", ann)
	}
}

func TestSSDRestorePatchPutsBackAValueThatWasThere(t *testing.T) {
	ann := ssdPatchAnnotations(t, ssdRestorePatch(ssdSnapshot{CompareOptions: "IgnoreExtraneous", HasCompareOptions: true}))
	if got := ann[ssdCompareOptionsAnnotation]; got == nil || *got != "IgnoreExtraneous" {
		t.Fatalf("a pre-existing value must be written back verbatim: %+v", ann)
	}
}

func TestSSDRestoreReportsSuccessOnlyWhenTheREREADAgrees(t *testing.T) {
	before := ssdSnapshot{}
	got := describeSSDRestore("addon-tempo", before, ssdSnapshot{}, nil)
	if strings.Contains(got, ssdRestoreFailed) {
		t.Fatalf("a verified restore must not shout: %q", got)
	}
	if !strings.Contains(got, "restored") {
		t.Fatalf("a verified restore must SAY so — silence reads as though nothing was changed: %q", got)
	}
}

func TestSSDRestoreShoutsWhenThePatchFailed(t *testing.T) {
	got := describeSSDRestore("addon-tempo", ssdSnapshot{}, ssdSnapshot{}, errors.New("exit status 1"))
	if !strings.Contains(got, ssdRestoreFailed) {
		t.Fatalf("a failed restore must be loud: %q", got)
	}
	if !strings.Contains(got, "annotate applications.argoproj.io addon-tempo") {
		t.Fatalf("a failed restore must say how to undo it by hand: %q", got)
	}
}

func TestSSDRestoreShoutsWhenTheAnnotationSURVIVEDASuccessfulPatch(t *testing.T) {
	// The trap: `kubectl patch` exits 0 and the annotation is still there (a webhook rewrote it, a
	// controller re-applied the Application). "The write returned 0" and "the object no longer
	// carries it" are different claims, and only the second one is what the run depends on.
	got := describeSSDRestore("addon-tempo",
		ssdSnapshot{},
		ssdSnapshot{CompareOptions: ssdCompareOption, HasCompareOptions: true},
		nil)
	if !strings.Contains(got, ssdRestoreFailed) {
		t.Fatalf("a restore that did not take must be loud: %q", got)
	}
}

func TestSSDRestoreShoutsWhenAPriorValueWasNotPutBack(t *testing.T) {
	got := describeSSDRestore("addon-tempo",
		ssdSnapshot{CompareOptions: "IgnoreExtraneous", HasCompareOptions: true},
		ssdSnapshot{CompareOptions: ssdCompareOption, HasCompareOptions: true},
		nil)
	if !strings.Contains(got, ssdRestoreFailed) {
		t.Fatalf("a value restored to the WRONG value must be loud: %q", got)
	}
}

func TestPickSSDExperimentAppsPrefersTheCleanestCase(t *testing.T) {
	got := pickSSDExperimentApps([]string{"addon-harbor", "addon-loki", "addon-tempo"})
	want := []string{"addon-tempo", "addon-harbor"}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestPickSSDExperimentAppsIsBounded(t *testing.T) {
	got := pickSSDExperimentApps([]string{"addon-tempo", "addon-harbor", "addon-keda", "addon-loki"})
	if len(got) != maxSSDExperimentApps {
		t.Fatalf("the experiment patches LIVE objects on a failing path and must stay bounded: %v", got)
	}
}

func TestPickSSDExperimentAppsFallsBackToWhateverIsFailing(t *testing.T) {
	// The experiment is about the controller's comparison, not about three named charts, so an
	// unlisted Application is still a valid subject. Deterministic order, so two runs of the same
	// failure experiment on the same Applications.
	got := pickSSDExperimentApps([]string{"addon-valkey", "addon-loki"})
	if len(got) != 2 || got[0] != "addon-loki" || got[1] != "addon-valkey" {
		t.Fatalf("unlisted losers must be taken in name order, got %v", got)
	}
}

func TestPickSSDExperimentAppsPicksNothingFromNothing(t *testing.T) {
	if got := pickSSDExperimentApps(nil); len(got) != 0 {
		t.Fatalf("nothing OutOfSync means nothing to experiment on, got %v", got)
	}
}

func TestSSDExperimentSectionSaysWhenThereIsNothingToRunOn(t *testing.T) {
	// "we did not look" and "there was nothing to look at" are opposite findings that both print
	// zero verdicts.
	got := argoSSDExperiment(t.Context(), "/nonexistent-kubeconfig", nil)
	if !strings.Contains(got, "no OutOfSync Application to run it on") {
		t.Fatalf("the empty case must state itself: %q", got)
	}
	if strings.Contains(got, "COULD NOT ASK") {
		t.Fatalf("nothing to measure is not a failure to measure: %q", got)
	}
}

func TestSSDExperimentWithoutAClusterCannotAskAndPatchesNothing(t *testing.T) {
	// The whole live path, against a kubeconfig that does not exist: the first read fails, so
	// NOTHING is patched, and the report says COULD NOT ASK rather than either verdict.
	got := argoSSDExperiment(t.Context(), "/nonexistent-kubeconfig", []string{"addon-tempo"})
	assertOneVerdict(t, got, "COULD NOT ASK")
	if strings.Contains(got, ssdRestoreFailed) {
		t.Fatalf("nothing was patched, so nothing may be reported as an un-restored change: %q", got)
	}
}
