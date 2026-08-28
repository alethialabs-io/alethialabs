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
	"strings"
	"testing"
)

// ssdObs builds an observation that differs from a clean one only in what a test varies. The
// default is a well-formed window: the settle reconcile is strictly after the pre-flip read, the
// verdict reconcile is strictly after the settle, the generation is unchanged, and no sync
// operation ran.
func ssdObs(afterSync string) ssdObservation {
	return ssdObservation{
		App: "addon-tempo",
		Before: ssdSnapshot{
			Generation:         7,
			Sync:               "OutOfSync",
			ReconciledAt:       "2026-08-28T13:49:00Z",
			OperationStartedAt: "2026-08-28T13:20:00Z",
		},
		Settle: ssdSnapshot{
			Generation:         7,
			Sync:               "OutOfSync",
			ReconciledAt:       "2026-08-28T13:49:40Z",
			OperationStartedAt: "2026-08-28T13:20:00Z",
		},
		After: ssdSnapshot{
			Generation:         7,
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
	got := describeSSDExperiment(ssdObs("Synced"))
	assertOneVerdict(t, got, "FLIP WOULD FIX IT")
	if !strings.Contains(got, "addon-tempo") {
		t.Fatalf("the verdict must name the Application it was measured on: %q", got)
	}
	if !strings.Contains(got, "NO sync operation in the window") {
		t.Fatalf("the alternative explanation must be excluded IN THE TEXT, not silently: %q", got)
	}
}

func TestSSDExperimentFlipWouldNotFixIt(t *testing.T) {
	got := describeSSDExperiment(ssdObs("OutOfSync"))
	// "FLIP WOULD NOT FIX IT" contains neither of the other two verdict strings, and this is the
	// assertion that keeps it that way if the wording is ever edited.
	assertOneVerdict(t, got, "FLIP WOULD NOT FIX IT")
	if !strings.Contains(got, "STILL OutOfSync") {
		t.Fatalf("the negative verdict must say what was observed: %q", got)
	}
}

func TestSSDExperimentCannotAskWhenTheQuestionCouldNotBePut(t *testing.T) {
	obs := ssdObs("Synced")
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
			obs := ssdObs("Synced")
			mutate(&obs)
			assertOneVerdict(t, describeSSDExperiment(obs), "COULD NOT ASK")
		})
	}
}

func TestSSDExperimentCannotAskWhenTheSpecMovedUnderIt(t *testing.T) {
	obs := ssdObs("Synced")
	obs.After.Generation = obs.Before.Generation + 1
	got := describeSSDExperiment(obs)
	assertOneVerdict(t, got, "COULD NOT ASK")
	if !strings.Contains(got, "generation") {
		t.Fatalf("the reason must name what moved: %q", got)
	}
}

func TestSSDExperimentCannotCreditTheFlipForASync(t *testing.T) {
	// These add-ons run automated sync with selfHeal, so a heal landing inside the window is a real
	// alternative explanation for Synced. Crediting the flip for it would be the same class of
	// error as reading a stale status.
	obs := ssdObs("Synced")
	obs.After.OperationStartedAt = "2026-08-28T13:49:40Z"
	got := describeSSDExperiment(obs)
	assertOneVerdict(t, got, "COULD NOT ASK")
	if !strings.Contains(got, "SYNC OPERATION") {
		t.Fatalf("the confounder must be named: %q", got)
	}
}

func TestSSDExperimentASyncInTheWindowDoesNotSoftenTheNegative(t *testing.T) {
	// The asymmetry is deliberate and worth pinning: a sync landing in the window cannot explain a
	// status that is STILL OutOfSync, so it must not downgrade that verdict.
	obs := ssdObs("OutOfSync")
	obs.After.OperationStartedAt = "2026-08-28T13:49:40Z"
	assertOneVerdict(t, describeSSDExperiment(obs), "FLIP WOULD NOT FIX IT")
}

func TestSSDExperimentUnknownStatusIsNotAVerdict(t *testing.T) {
	for _, status := range []string{"", "Unknown", "Progressing"} {
		assertOneVerdict(t, describeSSDExperiment(ssdObs(status)), "COULD NOT ASK")
	}
}

func TestSSDExperimentAlwaysReportsFreshness(t *testing.T) {
	// Including on the could-not-ask paths. The numbers that would reveal a misread verdict must
	// not be the thing omitted when the probe is unsure.
	obs := ssdObs("Synced")
	obs.AskErr = errors.New("boom")
	for _, o := range []ssdObservation{ssdObs("Synced"), ssdObs("OutOfSync"), obs} {
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
	got := describeSSDExperiment(ssdObs("Synced"))
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
		Sync:               "OutOfSync",
		ReconciledAt:       "2026-08-28T13:49:26Z",
		OperationStartedAt: "2026-08-28T13:20:00Z",
	}
	if got != want {
		t.Fatalf("snapshot mismatch:\n got %+v\nwant %+v", got, want)
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
