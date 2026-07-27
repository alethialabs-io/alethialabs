// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure unit tests for the day-2 offer RUN-harness support (#1495) — the mutation planner, the
// plan decoder and the summary verdict. Untagged, so ci.yml runs them on every PR.
//
// The mutation planner is the piece that carries the real risk. AnalyzeDay2 fails hard on an
// empty changeset by design, so a mutation that proposes nothing turns into a confusing run
// failure rather than a silent pass — but only if `Applied` honestly reports whether anything
// was mutated. Every test below is about keeping that report honest.
package e2e

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

func day2IntPtr(v int) *int { return &v }

// TestApplyDay2UpdateBumpsRetention pins the cloud-indifferent update axis: retention +1 on
// every database offer, from an explicit value and from the unset default alike.
func TestApplyDay2UpdateBumpsRetention(t *testing.T) {
	dbs := []types.ProjectDatabaseConfig{
		{Name: "explicit", BackupRetentionDays: day2IntPtr(3)},
		{Name: "unset"},
	}
	m := applyDay2Update(dbs)
	if !m.Applied {
		t.Fatalf("update mutation did not apply: %s", m.Detail)
	}
	if m.Op != Day2Update {
		t.Errorf("op = %q, want %q", m.Op, Day2Update)
	}
	if got := *dbs[0].BackupRetentionDays; got != 4 {
		t.Errorf("explicit retention = %d, want 4", got)
	}
	// An unset retention must still produce a CHANGE — leaving it nil would plan nothing and
	// the run would fail on an empty changeset with no hint why.
	if dbs[1].BackupRetentionDays == nil {
		t.Fatal("unset retention stayed nil — the mutation would plan no change")
	}
	if got := *dbs[1].BackupRetentionDays; got != 8 {
		t.Errorf("defaulted retention = %d, want 8 (default 7 + 1)", got)
	}
}

// TestApplyDay2UpdateNoDatabases keeps "nothing to mutate" distinguishable from "mutated".
func TestApplyDay2UpdateNoDatabases(t *testing.T) {
	m := applyDay2Update(nil)
	if m.Applied {
		t.Error("reported a mutation with no database offer present")
	}
	if !strings.Contains(m.Detail, "no database offer") {
		t.Errorf("detail should say why nothing was mutated, got %q", m.Detail)
	}
}

// TestApplyDay2ResizeUsesPerCloudClass covers the one axis that cannot be cloud-indifferent:
// every cloud that ships a template must have a resize target, and it must differ from the
// template default it replaces (else the plan is empty).
func TestApplyDay2ResizeUsesPerCloudClass(t *testing.T) {
	defaults := map[string]string{
		"aws":     "db.serverless",
		"gcp":     "db-f1-micro",
		"azure":   "B_Standard_B1ms",
		"alibaba": "pg.n2.small.2c",
	}
	for provider, def := range defaults {
		t.Run(provider, func(t *testing.T) {
			target, ok := day2ResizeClass[provider]
			if !ok {
				t.Fatalf("no resize target recorded for %s — resize can never run there", provider)
			}
			if target == def {
				t.Fatalf("resize target %q equals the template default — the plan would be empty", target)
			}
			dbs := []types.ProjectDatabaseConfig{{Name: "db", InstanceClass: def}}
			m := applyDay2Resize(dbs, provider)
			if !m.Applied {
				t.Fatalf("resize did not apply: %s", m.Detail)
			}
			if dbs[0].InstanceClass != target {
				t.Errorf("instance class = %q, want %q", dbs[0].InstanceClass, target)
			}
		})
	}
}

// TestApplyDay2ResizeRefusesNoOp is the vacuity guard: resizing to the class the offer already
// runs plans nothing, so it must be reported as not-applied rather than handed on as a mutation.
func TestApplyDay2ResizeRefusesNoOp(t *testing.T) {
	dbs := []types.ProjectDatabaseConfig{{Name: "db", InstanceClass: day2ResizeClass["gcp"]}}
	m := applyDay2Resize(dbs, "gcp")
	if m.Applied {
		t.Error("resize to the CURRENT class reported as applied — that plans no change")
	}
}

// TestApplyDay2ResizeUnknownProvider — a provider with no recorded target is an honest skip.
func TestApplyDay2ResizeUnknownProvider(t *testing.T) {
	dbs := []types.ProjectDatabaseConfig{{Name: "db", InstanceClass: "whatever"}}
	m := applyDay2Resize(dbs, "hetzner")
	if m.Applied {
		t.Error("resize applied on a provider with no recorded target")
	}
	if dbs[0].InstanceClass != "whatever" {
		t.Error("an unapplied resize must not mutate the config")
	}
}

// TestPlanFromMapRejectsEmpty — "no plan" must never decode into "a plan with no changes".
func TestPlanFromMapRejectsEmpty(t *testing.T) {
	for _, raw := range []map[string]interface{}{nil, {}} {
		plan, err := planFromMap(raw)
		if err == nil {
			t.Fatalf("empty plan JSON decoded without error into %#v", plan)
		}
		if plan != nil {
			t.Errorf("want a nil plan on error, got %#v", plan)
		}
	}
}

// TestPlanFromMapDecodesResourceChanges proves the decoder preserves what AnalyzeDay2 reads —
// the round-trip through the untyped map the runner's result.json forces.
func TestPlanFromMapDecodesResourceChanges(t *testing.T) {
	raw := map[string]interface{}{
		"format_version": "1.2",
		"resource_changes": []interface{}{
			map[string]interface{}{
				"address": "module.rds.aws_db_instance.main",
				"type":    "aws_db_instance",
				"mode":    "managed",
				"change":  map[string]interface{}{"actions": []interface{}{"update"}},
			},
		},
	}
	plan, err := planFromMap(raw)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(plan.ResourceChanges) != 1 {
		t.Fatalf("resource_changes = %d, want 1", len(plan.ResourceChanges))
	}
	// The decoded plan must drive the classifier end to end — that is the only thing the
	// decoder exists for.
	p, err := AnalyzeDay2(Day2Update, plan)
	if err != nil {
		t.Fatalf("AnalyzeDay2 over the decoded plan: %v", err)
	}
	if !p.Safe {
		t.Errorf("an in-place update should be safe, got: %s", p.Verdict)
	}
}

// TestOfferVerdictRequiresAPostureThatRan is the anti-vacuity rule for the summary: a run where
// every op was skipped is a FAILURE, not a pass. A gate that reports success having asserted
// nothing is the exact shape this surface exists to refuse.
func TestOfferVerdictRequiresAPostureThatRan(t *testing.T) {
	if offerVerdictPass(OfferSummary{Enabled: true, Skipped: []string{"everything"}}) {
		t.Error("a run with no posture that executed passed the verdict")
	}
	if offerVerdictPass(OfferSummary{Enabled: false, Postures: []*Day2Posture{{Safe: true}}}) {
		t.Error("a disabled run passed the verdict")
	}
	if !offerVerdictPass(OfferSummary{Enabled: true, Postures: []*Day2Posture{{Op: Day2Update, Safe: true}}}) {
		t.Error("a single safe posture should pass")
	}
	if offerVerdictPass(OfferSummary{Enabled: true, Postures: []*Day2Posture{
		{Op: Day2Update, Safe: true},
		{Op: Day2Destroy, Safe: false},
	}}) {
		t.Error("one unsafe posture must sink the verdict")
	}
}

// TestOfferSummaryVerdictRenders checks the one-line human summary the nightly folds into its
// per-provider step summary.
func TestOfferSummaryVerdictRenders(t *testing.T) {
	if got := offerSummaryVerdict(OfferSummary{}); !strings.Contains(got, "skipped") {
		t.Errorf("a disabled run should render as skipped, got %q", got)
	}
	got := offerSummaryVerdict(OfferSummary{
		Enabled:  true,
		Provider: "gcp",
		Postures: []*Day2Posture{{Op: Day2Update, Safe: true}, {Op: Day2Destroy, Safe: false}},
		Skipped:  []string{"resize: no target"},
	})
	for _, want := range []string{"❌", "gcp", "update=true", "destroy=false", "resize: no target"} {
		if !strings.Contains(got, want) {
			t.Errorf("verdict %q is missing %q", got, want)
		}
	}
}

// TestWriteOfferSummary round-trips the summary file the nightly reads back.
func TestWriteOfferSummary(t *testing.T) {
	path := filepath.Join(t.TempDir(), "day2-offer.json")
	s := OfferSummary{Enabled: true, Provider: "aws", Verdict: "✅ day2-offer (aws): update=true"}
	if err := writeOfferSummary(path, s); err != nil {
		t.Fatalf("write: %v", err)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if !strings.Contains(string(b), `"provider": "aws"`) {
		t.Errorf("summary file does not carry the provider:\n%s", b)
	}
}
