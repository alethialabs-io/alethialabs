// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
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

// TestCorpus is the Phase-0 go/no-go measurement harness. It evaluates a corpus
// of real OpenTofu plan JSONs and reports the verdict distribution, plus — when a
// `labels.json` ground-truth file is present — the false-PASS and false-DENY
// rates that decide whether the gate is trustworthy enough to build receipts on.
//
// It is skipped by default (no corpus checked in). Point it at a directory of
// plan JSONs:
//
//	ELENCH_CORPUS_DIR=/path/to/plans go test ./packages/core/verify -run TestCorpus -v
//
// Optional ground truth: a `labels.json` in that dir mapping each plan filename to
// its expected verdict, e.g. {"prod-eks.json":"pass","legacy.json":"fail"}.
//   - false-PASS = expected "fail" but the gate did NOT block (pass/warn/not_evaluable)
//   - false-DENY = expected "pass" but the gate blocked (fail)
func TestCorpus(t *testing.T) {
	dir := os.Getenv("ELENCH_CORPUS_DIR")
	if dir == "" {
		dir = filepath.Join("testdata", "corpus")
	}
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
		t.Logf("%-40s verdict=%-13s (pass=%d fail=%d warn=%d n/e=%d)",
			name, rep.Verdict, rep.Summary.Pass, rep.Summary.Fail, rep.Summary.Warn, rep.Summary.NotEvaluable)

		if want, ok := labels[name]; ok {
			labeled++
			blocked := rep.Blocking()
			switch want {
			case StatusFail:
				if !blocked {
					falsePass++
					t.Errorf("FALSE-PASS %s: expected the gate to block, got verdict=%s", name, rep.Verdict)
				}
			case StatusPass:
				if blocked {
					falseDeny++
					t.Errorf("FALSE-DENY %s: expected the gate to allow, got verdict=%s", name, rep.Verdict)
				}
			}
		}
	}

	t.Logf("corpus verdict distribution: pass=%d warn=%d not_evaluable=%d fail=%d",
		dist[StatusPass], dist[StatusWarn], dist[StatusNotEvaluable], dist[StatusFail])
	if labeled > 0 {
		t.Logf("ground truth over %d labeled plans: false-PASS=%d false-DENY=%d", labeled, falsePass, falseDeny)
	} else {
		t.Logf("no labels.json — distribution only (add labels to measure false-PASS/false-DENY)")
	}
}

// loadLabels reads optional ground-truth labels; absence is not an error.
func loadLabels(t *testing.T, path string) map[string]Status {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var raw map[string]string
	if err := json.Unmarshal(b, &raw); err != nil {
		t.Fatalf("labels.json is present but invalid: %v", err)
	}
	out := make(map[string]Status, len(raw))
	for k, v := range raw {
		out[k] = Status(v)
	}
	return out
}
