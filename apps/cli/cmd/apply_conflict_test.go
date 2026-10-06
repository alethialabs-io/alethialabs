// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

// #5551: apply's update is computed against the copy plan READ, and may only land on that copy.

// revisioned returns the two-environment fake with a revision on every component, as a server that
// sends `updated_at` answers.
func revisioned() *diffFake {
	f := diffTwoEnvFake()
	for env, comps := range f.comps {
		for i := range comps {
			rev := "2026-10-06T10:00:0" + string(rune('0'+i)) + ".000Z-" + env
			comps[i].UpdatedAt = &rev
		}
	}
	return f
}

// TestExecuteApply_SendsTheRevisionThePlanRead: each update carries, as If-Match, the revision of the
// component the plan diffed against — named and singleton alike — and the plan's JSON shows it.
func TestExecuteApply_SendsTheRevisionThePlanRead(t *testing.T) {
	f := revisioned()
	// Make the cluster differ too, so the singleton path is exercised.
	f.comps["prod"][0].Config["node_max_size"] = float64(3)
	plan, err := computePlan(f, diffManifest(t, diffTwoEnvManifest), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := executeApply(f, &bytes.Buffer{}, ui.FormatTable, plan, "", false); err != nil {
		t.Fatal(err)
	}
	wantCalls := []string{"upsert cluster prod", "update databases/orders prod", "update databases/orders dev"}
	var gotCalls []string
	for _, c := range f.calls {
		label := c.Kind
		if c.Name != "" {
			label += "/" + c.Name
		}
		gotCalls = append(gotCalls, c.Method+" "+label+" "+c.Env)
	}
	if !reflect.DeepEqual(gotCalls, wantCalls) {
		t.Fatalf("calls %v, want %v", gotCalls, wantCalls)
	}
	want := []string{
		"2026-10-06T10:00:00.000Z-prod", // the cluster, prod's first component
		"2026-10-06T10:00:01.000Z-prod", // prod's orders
		"2026-10-06T10:00:00.000Z-dev",  // dev's orders
	}
	if !reflect.DeepEqual(f.ifMatch, want) {
		t.Errorf("If-Match sent %q, want the revisions the plan read %q", f.ifMatch, want)
	}

	raw, err := json.Marshal(plan)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"revision":"2026-10-06T10:00:01.000Z-prod"`) {
		t.Errorf("plan JSON does not carry the revision: %s", raw)
	}
}

// TestExecuteApply_NoRevisionIsAnUnconditionalWrite: a server that sends no `updated_at` gets no
// If-Match — the write it has always had — and a created component never carries one.
func TestExecuteApply_NoRevisionIsAnUnconditionalWrite(t *testing.T) {
	f := diffTwoEnvFake()
	plan, err := computePlan(f, diffManifest(t, diffTwoEnvManifest), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := executeApply(f, &bytes.Buffer{}, ui.FormatTable, plan, "", false); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(f.ifMatch, []string{"", ""}) {
		t.Errorf("If-Match sent %q, want none", f.ifMatch)
	}
}

// TestExecuteApply_AConcurrentEditNamesTheFieldsThatChanged: the console changed prod's orders after
// the plan read it. The server refuses the update with its copy now; apply names the fields that
// moved, tells the person to re-run plan, keeps prod from deploying, and dev carries on.
func TestExecuteApply_AConcurrentEditNamesTheFieldsThatChanged(t *testing.T) {
	f := revisioned()
	plan, err := computePlan(f, diffManifest(t, diffTwoEnvManifest), nil)
	if err != nil {
		t.Fatal(err)
	}
	now := "2026-10-06T10:05:00.000Z"
	f.refuse = map[string]error{"prod databases/orders": &api.ComponentConflictError{
		Code:    api.ConflictComponentChanged,
		Message: "databases/orders changed on the server since it was read",
		Status:  "ACTIVE",
		Current: &api.Component{Kind: "databases", Name: "orders", UpdatedAt: &now, Config: map[string]any{
			"engine": "postgres", "max_capacity": float64(16), "port": float64(6543),
		}},
	}}
	var out bytes.Buffer
	result, err := executeApply(f, &out, ui.FormatTable, plan, "", false)
	if err == nil {
		t.Fatal("a refused update must fail the apply")
	}
	if len(result.Errors) != 1 {
		t.Fatalf("errors %+v, want one", result.Errors)
	}
	why := result.Errors[0].Error
	for _, want := range []string{
		"databases/orders changed on the server after `alethia plan` read it",
		"max_capacity: 4 → 16",
		"port: 5432 → 6543",
		"re-run `alethia plan`",
	} {
		if !strings.Contains(why, want) {
			t.Errorf("refusal %q does not say %q", why, want)
		}
	}
	if strings.Contains(why, "engine") {
		t.Errorf("refusal %q names a field that did not change", why)
	}
	if !strings.Contains(out.String(), "prod not deployed: a component update was refused") {
		t.Errorf("prod was not held back:\n%s", out.String())
	}
	if len(f.jobs) != 1 || f.jobs[0] != "e2" {
		t.Errorf("deploys queued for %v, want only dev (e2)", f.jobs)
	}
}

// TestComponentUpdateRefusal_EachConflictReadsAsItsOwnNextStep covers the remaining shapes: a deploy
// running, a destroy queued, a run that finished before the server explained it, removed since the read, re-saved with no setting changed, and a plain error.
func TestComponentUpdateRefusal_EachConflictReadsAsItsOwnNextStep(t *testing.T) {
	comp := ComponentPlan{Kind: "databases", Name: "orders", read: map[string]any{"max_capacity": float64(4)}}
	for name, tc := range map[string]struct {
		err  error
		want []string
	}{
		"deploy running": {
			&api.ComponentConflictError{Code: api.ConflictComponentBusy, Status: "ACTIVE", Run: &api.ComponentRun{ID: "j-1", Type: "DEPLOY", Status: "PROCESSING"}},
			[]string{"databases/orders cannot be changed while a deploy of this environment is processing (job j-1)", "`alethia jobs logs j-1 --follow`", "re-run `alethia apply`"},
		},
		"build running": {
			&api.ComponentConflictError{Code: api.ConflictComponentBusy, Run: &api.ComponentRun{ID: "j-3", Type: "BUILD", Status: "PROCESSING"}},
			[]string{"while a deploy (its image build) of this environment is processing (job j-3)", "`alethia jobs logs j-3 --follow`"},
		},
		"promotion awaiting approval": {
			&api.ComponentConflictError{Code: api.ConflictComponentBusy, Run: &api.ComponentRun{ID: "p-1", Type: "PROMOTION", Status: "PENDING_APPROVAL"}},
			[]string{"while a promotion into this environment is pending approval (promotion p-1)", "`alethia promotion get p-1`"},
		},
		"destroy queued": {
			&api.ComponentConflictError{Code: api.ConflictComponentBusy, Status: "ACTIVE", Run: &api.ComponentRun{ID: "j-2", Type: "DESTROY", Status: "QUEUED"}},
			[]string{"while a destroy of this environment is queued (job j-2)"},
		},
		"run finished since": {
			&api.ComponentConflictError{Code: api.ConflictComponentBusy, Status: "ACTIVE"},
			[]string{"was in progress when apply sent the change, and has finished since", "re-run `alethia apply`"},
		},
		"removed": {
			&api.ComponentConflictError{Code: api.ConflictComponentChanged},
			[]string{"no longer exists on the server", "re-run `alethia plan`"},
		},
		"re-saved": {
			&api.ComponentConflictError{Code: api.ConflictComponentChanged, Current: &api.Component{Config: map[string]any{"max_capacity": float64(4)}}},
			[]string{"none of its settings differ", "re-run `alethia plan`"},
		},
		"another failure": {
			errors.New("failed to update component: boom (status 500)"),
			[]string{"failed to update component: boom (status 500)"},
		},
	} {
		got := componentUpdateRefusal(comp, tc.err)
		for _, want := range tc.want {
			if !strings.Contains(got, want) {
				t.Errorf("%s: %q does not say %q", name, got, want)
			}
		}
	}
}
