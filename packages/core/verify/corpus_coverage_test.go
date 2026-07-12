// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package verify

import (
	"path/filepath"
	"testing"
)

// declaredControlIDs returns every control ID the offline engine can emit. It calls
// the per-cloud control sets directly (with no planned resources) purely to read
// their IDs — a control that exists in the engine but has no corpus coverage must be
// impossible, and this is the authoritative "what controls exist" source.
//
// ACCESS-ANALYZER-001 is deliberately excluded: it is opt-in (needs a live
// PolicyChecker via EvaluateWithOptions) and never runs under the offline corpus, so
// requiring a corpus plan for it would be dishonest. It is covered by options_test.go.
func declaredControlIDs() []string {
	var ids []string
	for _, c := range awsControls(nil) {
		ids = append(ids, c.ID)
	}
	for _, c := range gcpControls(nil) {
		ids = append(ids, c.ID)
	}
	for _, c := range azureControls(nil) {
		ids = append(ids, c.ID)
	}
	return ids
}

// TestCorpusControlCoverage is the anti-untested-control guard: every control the
// engine declares must have at least one plan in the corpus that is labeled "fail"
// and lists that control. Without this, a control could ship (or silently stop
// discriminating) with no failing evidence behind it. This is the corpus analogue of
// the mutation gate — mutate_test.go proves each control flips; this proves each
// control has a checked-in violating plan.
func TestCorpusControlCoverage(t *testing.T) {
	labels := loadLabels(t, filepath.Join(corpusDir(), "labels.json"))
	if len(labels) == 0 {
		t.Fatal("no labels.json in the corpus — cannot assert control coverage")
	}

	// control ID -> the fail-labeled plans that exercise it.
	failPlans := map[string][]string{}
	for name, label := range labels {
		if label.Verdict != StatusFail {
			continue
		}
		for _, id := range label.Controls {
			failPlans[id] = append(failPlans[id], name)
		}
	}

	for _, id := range declaredControlIDs() {
		if len(failPlans[id]) == 0 {
			t.Errorf("control %s has NO fail-labeled corpus plan — it ships untested; add a violating plan + label it", id)
			continue
		}
		t.Logf("control %-20s covered by %d fail plan(s): %v", id, len(failPlans[id]), failPlans[id])
	}
}

// TestCorpusLabelsReferenceRealControls asserts every control ID named in labels.json
// is a control the engine actually declares — a typo'd control ID in a label would
// otherwise silently satisfy nothing.
func TestCorpusLabelsReferenceRealControls(t *testing.T) {
	labels := loadLabels(t, filepath.Join(corpusDir(), "labels.json"))
	if len(labels) == 0 {
		t.Skip("no labels.json in the corpus")
	}
	known := map[string]bool{}
	for _, id := range declaredControlIDs() {
		known[id] = true
	}
	for name, label := range labels {
		for _, id := range label.Controls {
			if !known[id] {
				t.Errorf("%s labels control %q which no control set declares (typo?)", name, id)
			}
		}
	}
}
