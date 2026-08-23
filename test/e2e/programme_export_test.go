// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

// The programme spine, exported for the ledger rollup.
//
// PROGRAMME.md's generated half answers "which (capability × cloud) cells are proven, and by what
// evidence?". Most of that is derived from the tree by scripts/programme-rollup.mjs — the proof
// ledger, the proof bundles, the workflow's gate references, the three exclusion YAMLs. But two
// inputs it needs live in GO tables: which (kind × cloud) pairs are a documented cloud CEILING
// versus our own DEBT (MaxConfigCarriage), and which demo steps a human must click (CLIReach).
//
// WHY AN EXPORT AND NOT A SECOND TABLE. The obvious move is to hand-author a third table naming the
// ceilings for the rollup to read. That would be the mistake this repo keeps paying for: two lists
// of the same fact, kept in step by hand, drifting. `docs/testing/runner-xcloud-parity.md` says
// hetzner is `✅ (nightly)` for cluster provision while `docs/testing/provisioning-e2e-parity.md`
// says `🚫` — two files in one directory, contradicting each other, both passing CI. So the rollup
// reads the tables that ALREADY exist and are ALREADY validated (MaxConfigCell.Validate,
// DemoStep.Validate), and this test is the only bridge: Node cannot parse Go, so Go writes JSON.
//
// It is the same generated-mirror-plus-staleness-diff shape the repo already uses six times
// (gen:keyless-cells, gen:node-disk, gen:offer-surface, gen:catalog, gen:matrix, and the hetzner
// data-services fixture). ci.yml runs this test and then `git diff --exit-code` on the artifact, so
// a table change that is not exported fails the build with the command to fix it.
//
// UNTAGGED on purpose — no build tag, no cloud, no cost. It runs on every PR, which is what makes
// the mirror trustworthy. A tagged export would only refresh on a nightly, i.e. never on the PR
// that changed the table.
//
// This file adds NO new facts. Every value it writes is read from MaxConfigKinds, CLIDemoSteps or
// DemoClouds. If you find yourself typing a cloud name or a reason string here, stop: it belongs in
// the table that owns it.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// programmeExportPath is the generated mirror. Committed, and diff-gated by ci.yml.
const programmeExportPath = "generated/programme.json"

// programmeCell is the serialisable projection of one MaxConfigCell. The func fields on
// MaxConfigKind (Apply/Populated) cannot be marshalled and carry no programme meaning, so the
// projection is deliberate rather than a `json:"-"` sprinkle on the real type: the export is a
// CONTRACT with the rollup, and it should be readable on its own.
type programmeCell struct {
	// Carriage is the MaxConfigCarriage verdict verbatim ("tofu" | "in_cluster" | "ceiling" |
	// "deferred"). The rollup maps the two exclusions to programme states and must be able to tell
	// them apart — a ceiling is about the cloud, deferral is about us.
	Carriage string `json:"carriage"`
	// Offered mirrors MaxConfigCell.Offered() so the rollup never re-derives "does this cloud
	// deliver this kind" by testing carriage names. One deriver, every consumer.
	Offered bool `json:"offered"`
	// Why is the documented reason for a non-tofu verdict; empty for CarriedByTofu.
	Why string `json:"why,omitempty"`
	// Chart names the shipped chart that backs a DeferredInProduct kind — the evidence that makes it
	// debt rather than a ceiling.
	Chart string `json:"chart,omitempty"`
	// Resource / ArgoApp are what a real apply must produce, carried so the ledger can say what
	// evidence a cell would need.
	Resource string `json:"resource,omitempty"`
	ArgoApp  string `json:"argo_app,omitempty"`
}

// programmeKind is one row of the max-config surface: the kind, and its verdict per cloud.
type programmeKind struct {
	Kind string `json:"kind"`
	Doc  string `json:"doc"`
	// Foundational marks network/cluster — asserted positively only, never dropped.
	Foundational bool `json:"foundational"`
	// Cells is cloud → verdict. Keyed by cloud so the rollup indexes rather than positionally
	// unpacking; adding a cloud must not silently shift a column.
	Cells map[string]programmeCell `json:"cells"`
}

// programmeCLIStep is the serialisable projection of one DemoStep.
type programmeCLIStep struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	// Reach is the CLIReach verdict verbatim ("cli" | "cli_gap" | "cloud_manual" | "console_only").
	Reach string `json:"reach"`
	Why   string `json:"why,omitempty"`
	Issue string `json:"issue,omitempty"`
	// Clouds is empty when the step applies to every cloud — carried verbatim so the rollup uses
	// AppliesTo semantics rather than inventing its own.
	Clouds []string `json:"clouds,omitempty"`
}

// programmeExport is the whole artifact.
type programmeExport struct {
	// Doc tells a reader of the JSON where it came from, because a generated file is found by
	// someone who did not go looking for it.
	Doc string `json:"_doc"`
	// Clouds is DemoClouds — the canonical cloud order for every grid the rollup renders.
	Clouds []string `json:"clouds"`
	// Kinds is the max-config surface (the 11 provisionable kinds — the PROOF grid).
	Kinds []programmeKind `json:"kinds"`
	// CLISteps is the CLI-only demo bar's table.
	CLISteps []programmeCLIStep `json:"cli_steps"`
}

// buildProgrammeExport projects the live Go tables. Pure: no fs, no env.
func buildProgrammeExport(t *testing.T) programmeExport {
	t.Helper()

	kinds := make([]programmeKind, 0, len(MaxConfigKinds))
	for _, k := range MaxConfigKinds {
		cells := make(map[string]programmeCell, len(DemoClouds))
		for _, cloud := range DemoClouds {
			cell, ok := k.Cell(cloud)
			if !ok {
				// A kind with no verdict for a declared cloud is the "unmapped cell read as pending"
				// defect MaxConfigCarriage exists to kill. Fail here too rather than emitting a hole
				// the rollup would have to interpret.
				t.Fatalf("kind %q has no cell for cloud %q — every (kind × cloud) pair needs a verdict", k.Kind, cloud)
			}
			if err := cell.Validate(); err != nil {
				t.Fatalf("kind %q cloud %q: cell is not a well-formed verdict: %v", k.Kind, cloud, err)
			}
			cells[cloud] = programmeCell{
				Carriage: string(cell.Carriage),
				Offered:  cell.Offered(),
				Why:      cell.Why,
				Chart:    cell.Chart,
				Resource: cell.Resource,
				ArgoApp:  cell.ArgoApp,
			}
		}
		kinds = append(kinds, programmeKind{
			Kind:         k.Kind,
			Doc:          k.Doc,
			Foundational: k.Foundational,
			Cells:        cells,
		})
	}

	steps := make([]programmeCLIStep, 0, len(CLIDemoSteps))
	for _, s := range CLIDemoSteps {
		if err := s.Validate(); err != nil {
			t.Fatalf("CLI demo step %q is not a well-formed verdict: %v", s.ID, err)
		}
		steps = append(steps, programmeCLIStep{
			ID:     s.ID,
			Title:  s.Title,
			Reach:  string(s.Reach),
			Why:    s.Why,
			Issue:  s.Issue,
			Clouds: s.Clouds,
		})
	}

	return programmeExport{
		Doc: "GENERATED by test/e2e/programme_export_test.go from MaxConfigKinds + CLIDemoSteps. " +
			"Do not edit. Regenerate: GOWORK=off go test ./test/e2e -run TestProgrammeExport. " +
			"Consumed by scripts/programme-rollup.mjs to render PROGRAMME.md's generated half.",
		Clouds:   DemoClouds,
		Kinds:    kinds,
		CLISteps: steps,
	}
}

// TestProgrammeExport writes the mirror. ci.yml runs it and then diffs the artifact, so the test
// PASSING is not the gate — the gate is that the committed file already matched.
func TestProgrammeExport(t *testing.T) {
	export := buildProgrammeExport(t)

	// Tab-indented + trailing newline, matching the repo's other generated JSON, so the diff gate
	// compares content and never whitespace style.
	b, err := json.MarshalIndent(export, "", "\t")
	if err != nil {
		t.Fatalf("marshal programme export: %v", err)
	}
	b = append(b, '\n')

	if err := os.MkdirAll(filepath.Dir(programmeExportPath), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(programmeExportPath), err)
	}
	if err := os.WriteFile(programmeExportPath, b, 0o644); err != nil {
		t.Fatalf("write %s: %v", programmeExportPath, err)
	}
	t.Logf("wrote %s (%d kinds × %d clouds, %d CLI steps)", programmeExportPath, len(export.Kinds), len(export.Clouds), len(export.CLISteps))
}

// TestProgrammeExportIsNotVacuous pins the shape the rollup depends on. Without it, a projection bug
// that emitted an empty grid would still write a valid JSON file, the diff gate would be happy after
// one commit, and PROGRAMME.md would render "0 cells" as though that were the truth about the
// product. That is the a05-fidelity failure — a guard that compared 2 of 35 keys and read as green.
func TestProgrammeExportIsNotVacuous(t *testing.T) {
	export := buildProgrammeExport(t)

	if len(export.Clouds) != 5 {
		t.Fatalf("clouds = %d, want the 5 DemoClouds: %v", len(export.Clouds), export.Clouds)
	}
	// 11 provisionable kinds — the PROOF grid. Stated as a floor so adding a kind does not red this,
	// but shrinking the surface does.
	if len(export.Kinds) < 11 {
		t.Fatalf("kinds = %d, want at least the 11 max-config kinds", len(export.Kinds))
	}
	if len(export.CLISteps) < 20 {
		t.Fatalf("cli steps = %d, want at least the 20 happy-path demo steps", len(export.CLISteps))
	}

	for _, k := range export.Kinds {
		if len(k.Cells) != len(export.Clouds) {
			t.Errorf("kind %q has %d cells, want one per cloud (%d)", k.Kind, len(k.Cells), len(export.Clouds))
		}
		for cloud, c := range k.Cells {
			if c.Carriage == "" {
				t.Errorf("kind %q cloud %q exported an EMPTY carriage — the zero value must never reach the mirror", k.Kind, cloud)
			}
		}
	}
	for _, s := range export.CLISteps {
		if s.Reach == "" {
			t.Errorf("cli step %q exported an EMPTY reach", s.ID)
		}
	}

	// The two exclusion verdicts must stay DISTINGUISHABLE in the mirror. They are different facts —
	// a ceiling is about the cloud, deferral is about us — and collapsing them is exactly how
	// hetzner's registry→Harbor and secret→Vault debt stopped being counted. Today hetzner carries
	// both, so the mirror can prove the distinction survived projection rather than merely assert it
	// in a comment.
	seen := map[string]bool{}
	for _, k := range export.Kinds {
		for _, c := range k.Cells {
			seen[c.Carriage] = true
		}
	}
	for _, want := range []string{string(CarriedByTofu), string(CloudCeiling), string(DeferredInProduct)} {
		if !seen[want] {
			t.Errorf("no cell exported carriage %q — either the surface changed or the projection is dropping a verdict", want)
		}
	}
}
