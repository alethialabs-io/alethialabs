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
	"slices"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/catalog"
)

// programmeExportPath is the generated mirror. Committed, and diff-gated by ci.yml.
const programmeExportPath = "generated/programme.json"

// programmeCell is the serialisable projection of one MaxConfigCell. The func fields on
// MaxConfigKind (Apply/Populated) cannot be marshalled and carry no programme meaning, so the
// projection is deliberate rather than a `json:"-"` sprinkle on the real type: the export is a
// CONTRACT with the rollup, and it should be readable on its own.
type programmeCell struct {
	// Carriage is the MaxConfigCarriage verdict verbatim ("tofu" | "in_cluster" | "ceiling" |
	// "deferred" | "cost"). The rollup maps the three exclusions to programme states and must be able
	// to tell them apart — a ceiling is about the cloud, deferral is about us, and cost is about our
	// spend on a kind the cloud DOES offer.
	Carriage string `json:"carriage"`
	// Offered mirrors MaxConfigCell.Offered() so the rollup never re-derives "does this cloud
	// deliver this kind" by testing carriage names. One deriver, every consumer.
	Offered bool `json:"offered"`
	// Why is the documented reason for a non-tofu verdict; empty for CarriedByTofu.
	Why string `json:"why,omitempty"`
	// Chart names the shipped chart that backs a DeferredInProduct kind — the evidence that makes it
	// debt rather than a ceiling.
	Chart string `json:"chart,omitempty"`
	// Cost states what provisioning an ExcludedByCost kind would buy — the evidence that makes it a
	// spend decision rather than a ceiling. Carried so a reader of the grid sees the price, not just
	// the exclusion.
	Cost string `json:"cost,omitempty"`
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
	// RetiredClouds is RetiredClouds — the provisionable clouds the catalog marks hidden. The rollup
	// accepts a ledger row or a demo step that names one and scores neither. Without the list it
	// could not tell a retired cloud from a typo, and both would have to be an integrity failure.
	// No kind carries a cell for a retired cloud: Kinds is the scored grid.
	RetiredClouds []string `json:"retired_clouds"`
	// OfferedClouds is every cloud the catalog offers: the ones it marks `available`, in catalog
	// order, including any that can be connected but not provisioned. It is the Go half of beta
	// predicate B1 (docs/beta/README.md), which the rollup compares with the TypeScript catalog and
	// with the four clouds the beta is defined on. It equals Catalog.OfferedProviders() with the
	// operator setting unset; the setting is ignored here for the reason exitCriteriaClouds gives.
	OfferedClouds []string `json:"offered_clouds"`
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
				Cost:     cell.Cost,
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
		Clouds:        DemoClouds,
		RetiredClouds: RetiredClouds,
		OfferedClouds: offeredClouds(catalog.MustLoad()),
		Kinds:         kinds,
		CLISteps:      steps,
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

	// The cloud set is derived from the catalog, so its size is not typed here. What is pinned is a
	// FLOOR: the release is scored on four clouds, and scoring it on fewer must be a deliberate edit
	// to this number rather than a side effect of a catalog change.
	if len(export.Clouds) < 4 {
		t.Fatalf("clouds = %d, want at least the 4 clouds the release is scored on: %v", len(export.Clouds), export.Clouds)
	}
	if export.RetiredClouds == nil {
		t.Fatal("retired_clouds exported as null — the rollup needs a list, and an empty one is []")
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

	// The exclusion verdicts must stay DISTINGUISHABLE in the mirror. They are different facts — a
	// ceiling is about the cloud, deferral is about us — and collapsing them is exactly how hetzner's
	// registry→Harbor and secret→Vault debt stopped being counted.
	//
	// This used to be asserted by requiring one of EACH verdict somewhere in the table, which worked
	// while hetzner carried both and became a trap when it carried neither: #2431 and #2432 wired the
	// last two deferred cells, so the table now holds zero — the state we WANT — and the check would
	// have failed the build for it. The verdicts still present are asserted from the table; the
	// projection's ability to carry `deferred` at all is asserted directly, on a synthetic cell, so
	// it keeps its teeth whether or not any real cell is deferred.
	seen := map[string]bool{}
	for _, k := range export.Kinds {
		for _, c := range k.Cells {
			seen[c.Carriage] = true
		}
	}
	// CloudCeiling LEFT this list when hetzner's nosql was wired to ScyllaDB. It was the last
	// ceiling in the whole 55-cell grid, so no real cell carries the verdict any more — and
	// demanding a real one would fail for the best possible reason, which is exactly the trap
	// DeferredInProduct was already moved out of below. The projection's ability to CARRY a ceiling
	// is asserted on a synthetic cell instead, so the verdict keeps its teeth whether or not a cloud
	// ever refuses a kind again.
	for _, want := range []string{string(CarriedByTofu), string(CarriedInCluster)} {
		if !seen[want] {
			t.Errorf("no cell exported carriage %q — either the surface changed or the projection is dropping a verdict", want)
		}
	}
	if seen[string(CloudCeiling)] {
		// A NOTICE, and the mirror of the deferred one below: a cloud has started refusing a kind
		// again, which is a real change someone should have made deliberately.
		t.Logf("the table carries %s cells again — a cloud refuses a kind", CloudCeiling)
	}
	if got := projectedCarriage(ceilingCell("the cloud has no such service")); got != string(CloudCeiling) {
		t.Errorf("projectedCarriage(ceilingCell) = %q, want %q — the projection has lost the ceiling verdict", got, CloudCeiling)
	}
	if seen[string(DeferredInProduct)] {
		// Not a failure — a NOTICE, so a reader of a red or green log knows which state the table is
		// in. The ratchet in PROGRAMME.md is what actually bounds this (see
		// TestDeferredCellsStayUnderTheDeclaredRatchet).
		t.Logf("the table carries %s cells again — the projection is exercised by real data", DeferredInProduct)
	}
	if got := projectedCarriage(deferredCell("vault", "a shipped chart backs it — DEBT")); got != string(DeferredInProduct) {
		t.Errorf("the projection turns a %s cell into %q — the two exclusion verdicts would be indistinguishable in the mirror",
			DeferredInProduct, got)
	}
	if got := projectedCarriage(ceilingCell("the cloud has no such service")); got == projectedCarriage(deferredCell("vault", "DEBT")) {
		t.Error("a ceiling and a deferral project to the SAME carriage — the distinction this verdict set exists for is lost in the mirror")
	}
}

// projectedCarriage runs one cell through the SAME field mapping buildProgrammeExport uses, so the
// synthetic check above exercises the projection rather than a restatement of it.
func projectedCarriage(cell MaxConfigCell) string {
	return programmeCell{
		Carriage: string(cell.Carriage),
		Offered:  cell.Offered(),
		Why:      cell.Why,
		Chart:    cell.Chart,
		Cost:     cell.Cost,
		Resource: cell.Resource,
		ArgoApp:  cell.ArgoApp,
	}.Carriage
}

// TestExitCriteriaCloudsPartitionTheCatalog holds the scored and retired sets to the catalog. Every
// provisionable cloud must be in exactly one of them: a cloud in neither would leave the exit
// criteria without anything saying so, and a cloud in both would be scored and ignored at once.
func TestExitCriteriaCloudsPartitionTheCatalog(t *testing.T) {
	c := catalog.MustLoad()
	if len(c.Providers) == 0 {
		t.Fatal("the catalog lists no provisionable cloud — every assertion below would pass on nothing")
	}
	for _, p := range c.Providers {
		scored, retired := slices.Contains(DemoClouds, p.Slug), slices.Contains(RetiredClouds, p.Slug)
		if scored == retired {
			t.Errorf("catalog cloud %q: scored=%v retired=%v — it must be in exactly one set; check its availability in catalog.json", p.Slug, scored, retired)
		}
		availability, _ := c.Availability(p.Slug)
		if scored && availability != catalog.AvailabilityAvailable {
			t.Errorf("cloud %q is scored but the catalog marks it %q", p.Slug, availability)
		}
		if retired && availability != catalog.AvailabilityHidden {
			t.Errorf("cloud %q is retired but the catalog marks it %q", p.Slug, availability)
		}
	}
	if got, want := len(DemoClouds)+len(RetiredClouds), len(c.Providers); got != want {
		t.Errorf("scored + retired = %d clouds, the catalog lists %d provisionable — a cloud that is not provisionable was picked up", got, want)
	}

	// The mirror carries no cell for a retired cloud, so a retired cloud cannot be rendered or
	// counted by a consumer that forgets to filter.
	export := buildProgrammeExport(t)
	for _, k := range export.Kinds {
		for _, cloud := range export.RetiredClouds {
			if _, ok := k.Cells[cloud]; ok {
				t.Errorf("kind %q exports a cell for retired cloud %q", k.Kind, cloud)
			}
		}
	}
}

// offeredClouds lists the clouds the catalog itself offers, in catalog order: every connectable
// cloud it marks `available`. It never reads the operator setting, so the committed mirror does not
// depend on the environment of whoever regenerated it.
func offeredClouds(c *catalog.Catalog) []string {
	out := []string{}
	for _, p := range c.Live.Providers {
		if availability, _ := c.Availability(p.Slug); availability == catalog.AvailabilityAvailable {
			out = append(out, p.Slug)
		}
	}
	return out
}

// TestOfferedCloudsAreTheCatalogsOfferedSet holds the exported B1 set to the instrument
// docs/beta/README.md names, Catalog.OfferedProviders(), with the operator setting unset; and shows
// that the setting cannot widen the export.
func TestOfferedCloudsAreTheCatalogsOfferedSet(t *testing.T) {
	c := catalog.MustLoad()
	t.Setenv(catalog.HiddenCloudsEnv, "")
	if got, want := offeredClouds(c), c.OfferedProviders(); !slices.Equal(got, want) {
		t.Errorf("offeredClouds = %v, Catalog.OfferedProviders() = %v — the B1 mirror and the instrument disagree", got, want)
	}
	if len(offeredClouds(c)) == 0 {
		t.Fatal("the catalog offers no cloud — B1 would compare nothing")
	}

	synthetic := &catalog.Catalog{
		Live: catalog.Live{Providers: catalog.ConnectableProviders{
			{Slug: "north", Availability: catalog.AvailabilityAvailable},
			{Slug: "south", Availability: catalog.AvailabilityHidden},
			{Slug: "connect-only", Availability: catalog.AvailabilityAvailable},
		}},
	}
	if got := offeredClouds(synthetic); !slices.Equal(got, []string{"north", "connect-only"}) {
		t.Errorf("offeredClouds(synthetic) = %v, want [north connect-only]: a connect-only available cloud is offered, a hidden one is not", got)
	}
	t.Setenv(catalog.HiddenCloudsEnv, "south")
	if !synthetic.Offered("south") {
		t.Fatal("the setting did not re-enable the synthetic cloud, so the assertion below would prove nothing")
	}
	if got := offeredClouds(synthetic); slices.Contains(got, "south") {
		t.Errorf("with %s=south: offeredClouds = %v — the setting must not change the committed B1 set", catalog.HiddenCloudsEnv, got)
	}
}

// TestExitCriteriaCloudsOnASyntheticCatalog drives the split with clouds that are not real ones, so
// the rule is tested on its own terms and not only against the one cloud hidden today.
func TestExitCriteriaCloudsOnASyntheticCatalog(t *testing.T) {
	synthetic := &catalog.Catalog{
		Providers: []catalog.ProviderMeta{{Slug: "north"}, {Slug: "south"}, {Slug: "east"}, {Slug: "west"}},
		Live: catalog.Live{Providers: catalog.ConnectableProviders{
			{Slug: "north", Availability: catalog.AvailabilityAvailable},
			{Slug: "south", Availability: catalog.AvailabilityHidden},
			{Slug: "east", Availability: catalog.AvailabilityAvailable},
			// Connectable, hidden and NOT provisionable: never part of the exit criteria, so it
			// must not appear as retired.
			{Slug: "connect-only", Availability: catalog.AvailabilityHidden},
			// Provisionable with an availability nobody recognises: in neither set.
			{Slug: "west", Availability: catalog.Availability("soon")},
		}},
	}

	scored, retired := exitCriteriaClouds(synthetic)
	if !slices.Equal(scored, []string{"north", "east"}) {
		t.Errorf("scored = %v, want [north east] in catalog order", scored)
	}
	if !slices.Equal(retired, []string{"south"}) {
		t.Errorf("retired = %v, want [south]", retired)
	}

	// The operator setting re-enables a hidden cloud for a deployment. It must not move the cloud
	// back into the scored set: that would let an environment variable change the exit criteria.
	t.Setenv(catalog.HiddenCloudsEnv, "south")
	if !synthetic.Offered("south") {
		t.Fatal("the setting did not re-enable the synthetic cloud, so the assertion below would prove nothing")
	}
	scored, retired = exitCriteriaClouds(synthetic)
	if slices.Contains(scored, "south") || !slices.Contains(retired, "south") {
		t.Errorf("with %s=south: scored = %v, retired = %v — a re-enabled cloud must stay retired", catalog.HiddenCloudsEnv, scored, retired)
	}

	// No hidden cloud at all is a list, not null, in both directions.
	allAvailable := &catalog.Catalog{
		Providers: []catalog.ProviderMeta{{Slug: "north"}},
		Live:      catalog.Live{Providers: catalog.ConnectableProviders{{Slug: "north", Availability: catalog.AvailabilityAvailable}}},
	}
	if _, retired := exitCriteriaClouds(allAvailable); retired == nil || len(retired) != 0 {
		t.Errorf("retired = %#v, want an empty non-nil list", retired)
	}
}
