// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// planMetadataCase is one entry of testdata/plan-metadata/cases.json: a plan_result an earlier runner
// recorded, and what the current runner records for the same plan.
type planMetadataCase struct {
	Name   string         `json:"name"`
	Stored map[string]any `json:"stored"`
	Want   any            `json:"want"`
}

// loadPlanMetadataCases reads the fixture the console's plan metadata backfill
// (apps/console/scripts/backfill-plan-metadata.ts) is also tested against.
func loadPlanMetadataCases(t *testing.T) []planMetadataCase {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "plan-metadata", "cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Cases []planMetadataCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.Cases) == 0 {
		t.Fatal("the plan metadata fixture holds no cases")
	}
	return doc.Cases
}

// jsonShape round-trips v through JSON so two values compare by what they serialise to.
func jsonShape(t *testing.T, v any) any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// recordedPlanResult runs a plan whose `tofu show -json` is planJSON through the runner's plan path
// and returns the plan_result it posts.
func recordedPlanResult(t *testing.T, planJSON any) any {
	t.Helper()
	body, err := json.Marshal(map[string]any{"PlanJSON": planJSON})
	if err != nil {
		t.Fatal(err)
	}
	return jsonShape(t, runApplyPlanJob(t, string(body))["plan_result"])
}

// The runner records each fixture plan as the case's `want` — the same answer the console's backfill
// must reach from the case's `stored` row — and recording a `want` again changes nothing.
func TestPlanMetadataFixture_RunnerRecordsWant(t *testing.T) {
	for _, tc := range loadPlanMetadataCases(t) {
		t.Run(tc.Name, func(t *testing.T) {
			want := jsonShape(t, tc.Want)
			if got := recordedPlanResult(t, tc.Stored); !reflect.DeepEqual(got, want) {
				t.Errorf("plan_result = %#v, want %#v", got, want)
			}
			if got := recordedPlanResult(t, want); !reflect.DeepEqual(got, want) {
				t.Errorf("recording the current shape again = %#v, want it unchanged %#v", got, want)
			}
		})
	}
}
