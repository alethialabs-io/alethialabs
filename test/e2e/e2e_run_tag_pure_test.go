// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

// The `e2e-run` sweep handle (#5096), held without a cloud. Untagged, so ci.yml runs it on every PR:
// the handle's only reader is a sweeper looking for a stack that LEAKED, so a regression here is
// invisible on every run that tears down cleanly — which is every run anyone looks at.

import (
	"encoding/json"
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// ciEnv is the shape ALETHIA_E2E_ENV has in CI: `<run_id>-<attempt>`.
const ciEnv = "36135826614-1"

// TestE2ERunValueIsWhatTheSweepersAccept: the value the harness writes must be one the preflight
// discovery admits (scripts/e2e/lib/scope-key.sh e2e_scope_run_value_ok) AND one the console's
// classification slug schema accepts (apps/console/lib/validations/classification.ts slugSchema),
// or the CLI's assign is refused and the stack goes untagged.
func TestE2ERunValueIsWhatTheSweepersAccept(t *testing.T) {
	v := e2eRunValue(ciEnv)
	if v != "e2e-36135826614-1" {
		t.Fatalf("e2eRunValue(%q) = %q, want the seeded project-id handle's own shape e2e-<ENV>", ciEnv, v)
	}
	if !regexp.MustCompile(`^e2e-[0-9]+-[0-9]+$`).MatchString(v) {
		t.Errorf("%q is not the CI shape the preflight discovery accepts for the e2e-run handle", v)
	}
	if !regexp.MustCompile(`^[a-z0-9]+(?:[-_][a-z0-9]+)*$`).MatchString(v) || len(v) > 64 {
		t.Errorf("%q is not a classification slug — the console would refuse the dimension value", v)
	}
	if !regexp.MustCompile(`^[a-z0-9]+(?:[-_][a-z0-9]+)*$`).MatchString(e2eRunDimension) {
		t.Errorf("dimension key %q is not a classification slug", e2eRunDimension)
	}
}

// TestE2ERunClassificationDecodesIntoProjectConfig: the seeded snapshot's `classification` is the
// shape the runner decodes into ProjectConfig.Classification — which is what tags.go renders. A
// map the runner decoded as something else would tag nothing and fail nothing.
func TestE2ERunClassificationDecodesIntoProjectConfig(t *testing.T) {
	b, err := json.Marshal(map[string]any{"id": "e2e-" + ciEnv, "classification": e2eRunClassification(ciEnv)})
	if err != nil {
		t.Fatal(err)
	}
	var cfg types.ProjectConfig
	if err := json.Unmarshal(b, &cfg); err != nil {
		t.Fatalf("the runner could not decode the snapshot: %v", err)
	}
	if got := cfg.Classification[e2eRunDimension]; len(got) != 1 || got[0] != e2eRunValue(ciEnv) {
		t.Errorf("ProjectConfig.Classification[%q] = %v, want [%s]", e2eRunDimension, got, e2eRunValue(ciEnv))
	}
}

// TestSeededSnapshotsCarryTheE2ERunHandle: the untagged seeded builders stamp the handle. (The main
// spine's t2BaseSnapshot is build-tagged e2e_t2 and uses the same helper.)
func TestSeededSnapshotsCarryTheE2ERunHandle(t *testing.T) {
	check := func(name string, snap map[string]any) {
		t.Helper()
		got, ok := snap["classification"].(map[string][]string)
		if !ok {
			t.Errorf("%s: snapshot carries no classification map (got %T)", name, snap["classification"])
			return
		}
		if v := got[e2eRunDimension]; len(v) != 1 || v[0] != e2eRunValue(ciEnv) {
			t.Errorf("%s: classification[%q] = %v, want [%s]", name, e2eRunDimension, v, e2eRunValue(ciEnv))
		}
	}
	check("byo-iac", buildByoIacSnapshot("proj", ciEnv, "aws", "us-east-1", byoIacSource{}))
	realSnap, err := a05RealSnapshotFromFixture(map[string]any{"classification": map[string]any{}}, "proj", ciEnv, "aws", "us-east-1", "")
	if err != nil {
		t.Fatal(err)
	}
	check("A0.5 real snapshot", realSnap)
}

// TestE2ERunClassificationIsNotAFidelityDivergence: the fixture's canonical project is unclassified,
// so the seeded snapshot's classification differs from it BY CONSTRUCTION. It is a per-run input,
// like the project's name, and must be excluded from the A0.5 fidelity comparison — or every run
// with ALETHIA_E2E_A05_ENFORCE would hard-fail on the sweep handle.
func TestE2ERunClassificationIsNotAFidelityDivergence(t *testing.T) {
	seeded, err := a05NormalizeSnapshot(map[string]any{"classification": e2eRunClassification(ciEnv)})
	if err != nil {
		t.Fatal(err)
	}
	if diffs := a05SnapshotFidelity(seeded, map[string]any{"classification": map[string]any{}}); len(diffs) != 0 {
		t.Errorf("the run's classification reads as a fidelity divergence: %v", diffs)
	}
}

// TestCLIDemoClassifyBeat: the beat assigns THIS run's value through the real command, and it runs
// after the project exists and before anything is enqueued — the plan and deploy snapshot the
// classification that exists when they are enqueued, so a later beat would tag nothing.
func TestCLIDemoClassifyBeat(t *testing.T) {
	idx := map[string]int{}
	var classify *CLIDemoBeat
	for i := range CLIDemoBeats {
		idx[CLIDemoBeats[i].StepID] = i
		if CLIDemoBeats[i].StepID == "classify" {
			classify = &CLIDemoBeats[i]
		}
	}
	if classify == nil {
		t.Fatal("no `classify` beat — a CLI-created stack would carry no e2e-run handle and no sweeper could find it if it leaked (#5096)")
	}
	if classify.Phase != CLIDemoAuthoring {
		t.Errorf("classify runs in phase %q, want %q — the PLAN snapshots classification when it is enqueued", classify.Phase, CLIDemoAuthoring)
	}
	if idx["classify"] < idx["project-create"] {
		t.Error("classify runs before project-create — it has no project id to address")
	}
	r := &CLIDemoRun{ProjectID: "p-1", EnvName: ciEnv}
	got := strings.Join(classify.Args(r), " ")
	want := "classification assign project p-1 e2e-run e2e-36135826614-1 --no-input"
	if got != want {
		t.Errorf("classify argv = %q, want %q", got, want)
	}
	if classify.ReadBack == nil || classify.After == nil {
		t.Error("classify must read the classification back — an exit 0 from assign is not evidence the project is tagged")
	}
}

// TestAssertRunClassified: the read-back accepts exactly this run's value and nothing else.
func TestAssertRunClassified(t *testing.T) {
	for name, tc := range map[string]struct {
		out     string
		wantErr string
	}{
		"this run's value": {
			out: `[{"dimension_key":"e2e-run","dimension_label":"E2E run","value":"e2e-36135826614-1","value_label":"e2e-36135826614-1"}]`,
		},
		"alongside a customer's own dimension": {
			out: `[{"dimension_key":"team","value":"platform"},{"dimension_key":"e2e-run","value":"e2e-36135826614-1"}]`,
		},
		"unclassified (JSON null)": {
			out:     "null",
			wantErr: "no JSON array",
		},
		"unclassified (empty list)": {
			out:     "[]",
			wantErr: "want \"e2e-36135826614-1\"",
		},
		"another run's value": {
			out:     `[{"dimension_key":"e2e-run","value":"e2e-36135826614-2"}]`,
			wantErr: "e2e-36135826614-2",
		},
	} {
		t.Run(name, func(t *testing.T) {
			err := assertRunClassified(&CLIDemoRun{ProjectID: "p-1", EnvName: ciEnv}, tc.out)
			if tc.wantErr == "" && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tc.wantErr != "" && (err == nil || !strings.Contains(err.Error(), tc.wantErr)) {
				t.Fatalf("error = %v, want one containing %q", err, tc.wantErr)
			}
		})
	}
}

// TestCLIDemoSeedDefinesTheE2ERunDimension: the `classify` beat can only assign a value the ORG
// defines, and the org is seeded by the workflow — so the seed must be told this run's value, and
// the cli-demo dimension must scope its in-run sweep by the same handle. Read from the files rather
// than restated, because each half lives in a different language and nothing else joins them.
func TestCLIDemoSeedDefinesTheE2ERunDimension(t *testing.T) {
	wf, err := os.ReadFile("../../.github/workflows/e2e-nightly.yml")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(wf), `--e2e-run "e2e-${E2E_ENV}"`) {
		t.Error("e2e-nightly.yml's cli-demo seed step does not pass --e2e-run \"e2e-${E2E_ENV}\" — the org would " +
			"not define this run's value and the classify beat would be refused")
	}
	seed, err := os.ReadFile("../../apps/console/scripts/seed-cli-demo-token.mts")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(seed), `"`+e2eRunDimension+`"`) {
		t.Errorf("seed-cli-demo-token.mts never names the %q dimension", e2eRunDimension)
	}
	dim, err := os.ReadFile("../../scripts/e2e/resolve-dimension.sh")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(dim), "ALETHIA_E2E_SCOPE_KEY=e2e-run") {
		t.Error("resolve-dimension.sh no longer scopes the cli-demo in-run sweep by e2e-run — its project-id is a " +
			"UUID, so a project-id sweep would find nothing and report the account clean")
	}
}
