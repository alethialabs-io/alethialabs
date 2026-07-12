// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package verify

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"testing"

	tfjson "github.com/hashicorp/terraform-json"
)

// corpusLabel is one plan's ground truth: the overall verdict the engine is
// expected to produce, plus the control(s) the plan is designed to exercise. The
// control list powers the coverage assertion (corpus_coverage_test.go) — a control
// with no fail-labeled plan cannot ship untested.
type corpusLabel struct {
	Verdict  Status   `json:"verdict"`
	Controls []string `json:"controls"`
}

// corpusDir resolves the corpus directory: an override via ELENCH_CORPUS_DIR (for
// pointing the harness at a fleet of real captured plans) or the checked-in labeled
// corpus under testdata/corpus (the default, so this runs in CI).
func corpusDir() string {
	if dir := os.Getenv("ELENCH_CORPUS_DIR"); dir != "" {
		return dir
	}
	return filepath.Join("testdata", "corpus")
}

// TestCorpus is the compliance go/no-go harness. It evaluates every OpenTofu plan
// JSON in the labeled corpus and, against the labels.json ground truth, computes
// the two rates that decide whether the gate is trustworthy:
//
//   - false-PASS = a plan labeled "fail" (a real violation) that the gate did NOT
//     block. This is a SECURITY HOLE — a bad plan would reach apply — so it FAILS
//     the test hard (one is one too many).
//   - false-DENY = a plan labeled pass/warn/not_evaluable that the gate blocked. A
//     bug (it over-blocks a safe plan) but not a security hole, so it is reported
//     loudly and counted, not fatal.
//
// Unlike the earlier dormant version, this runs by default against the checked-in
// corpus (no env gating). Point it at a directory of real plans to measure the gate
// against production traffic:
//
//	ELENCH_CORPUS_DIR=/path/to/plans go test ./packages/core/verify -run TestCorpus -v
func TestCorpus(t *testing.T) {
	dir := corpusDir()
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) == 0 {
		t.Skipf("no corpus at %s (set ELENCH_CORPUS_DIR to measure); skipping", dir)
	}

	labels := loadLabels(t, filepath.Join(dir, "labels.json"))

	dist := map[Status]int{}
	var falsePass, falseDeny, labeled int

	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".json" || e.Name() == "labels.json" {
			continue
		}
		names = append(names, e.Name())
	}
	sort.Strings(names)

	for _, name := range names {
		b, readErr := os.ReadFile(filepath.Join(dir, name))
		if readErr != nil {
			t.Errorf("%s: read: %v", name, readErr)
			continue
		}
		var plan tfjson.Plan
		if err := json.Unmarshal(b, &plan); err != nil {
			t.Errorf("%s: not a valid plan JSON: %v", name, err)
			continue
		}
		rep, evalErr := Evaluate(context.Background(), &plan)
		if evalErr != nil {
			t.Errorf("%s: evaluate: %v", name, evalErr)
			continue
		}
		dist[rep.Verdict]++
		t.Logf("%-42s verdict=%-13s (pass=%d fail=%d warn=%d n/e=%d)",
			name, rep.Verdict, rep.Summary.Pass, rep.Summary.Fail, rep.Summary.Warn, rep.Summary.NotEvaluable)

		label, ok := labels[name]
		if !ok {
			// An unlabeled corpus plan is untested weight — fail so nobody can slip a
			// plan into the corpus without declaring what it proves.
			t.Errorf("UNLABELED %s: every corpus plan must have an entry in labels.json (verdict + controls)", name)
			continue
		}
		labeled++
		blocked := rep.Blocking()

		// The security-critical direction: a violation MUST block. Labels are
		// pass/fail/warn/not_evaluable; only fail requires blocking, the rest must not.
		//exhaustive:ignore
		switch label.Verdict {
		case StatusFail:
			if !blocked {
				falsePass++
				t.Errorf("FALSE-PASS %s: labeled fail but the gate did NOT block (verdict=%s) — a bad plan would reach apply", name, rep.Verdict)
			}
		default:
			// pass / warn / not_evaluable are all non-blocking labels.
			if blocked {
				falseDeny++
				t.Logf("FALSE-DENY (non-fatal) %s: labeled %s but the gate blocked (verdict=%s) — over-blocks a safe plan", name, label.Verdict, rep.Verdict)
			}
		}

		// Precision check (non-fatal): the exact verdict should match the label. A
		// mismatch that is not already a false-PASS/false-DENY (e.g. warn vs
		// not_evaluable) is a labeling or engine drift worth surfacing.
		if rep.Verdict != label.Verdict {
			t.Logf("VERDICT-MISMATCH (non-fatal) %s: got %s, labeled %s", name, rep.Verdict, label.Verdict)
		}
	}

	t.Logf("corpus verdict distribution: pass=%d warn=%d not_evaluable=%d fail=%d",
		dist[StatusPass], dist[StatusWarn], dist[StatusNotEvaluable], dist[StatusFail])
	t.Logf("ground truth over %d labeled plans: false-PASS=%d false-DENY=%d", labeled, falsePass, falseDeny)

	if falsePass > 0 {
		t.Fatalf("%d false-PASS(es): the gate let a labeled violation through — this is a security regression", falsePass)
	}
}

// loadLabels reads the corpus ground-truth labels. Absence returns nil (the harness
// then measures distribution only); a present-but-invalid file is a hard error.
func loadLabels(t *testing.T, path string) map[string]corpusLabel {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var raw map[string]corpusLabel
	if err := json.Unmarshal(b, &raw); err != nil {
		t.Fatalf("labels.json is present but invalid: %v", err)
	}
	return raw
}
