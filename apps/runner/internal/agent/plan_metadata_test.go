// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/sandbox"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// applyPlanFixture is an apply plan's PlanResult whose resource change carries values the posted
// metadata must not keep: a sensitive top-level attribute, a sensitive nested member, a sensitive
// array element, a wholly sensitive object, an unknown value, the prior state in `before`, and a
// plan-level variables block.
const applyPlanFixture = `{"PlanJSON":{
  "format_version":"1.2",
  "variables":{"db_password":{"value":"var-secret-never-posted"}},
  "resource_changes":[{
    "address":"aws_db_instance.main","mode":"managed","type":"aws_db_instance","name":"main",
    "provider_name":"registry.opentofu.org/hashicorp/aws",
    "change":{
      "actions":["update"],
      "before":{"password":"before-secret-never-posted","engine":"postgres"},
      "before_sensitive":{"password":true},
      "after":{
        "engine":"postgres","port":5432,"password":"top-secret-never-posted",
        "settings":{"token":"nested-secret-never-posted","region":"eu-west-1"},
        "users":[{"name":"app"},{"name":"admin","key":"element-secret-never-posted"}],
        "credentials":{"user":"whole-object-secret-never-posted"},
        "arn":"unknown-placeholder-never-posted"
      },
      "after_sensitive":{"password":true,"settings":{"token":true},"users":[{},{"key":true}],"credentials":true},
      "after_unknown":{"arn":true,"endpoint":true}
    }
  }]
}}`

// runApplyPlanJob drives executePlan for an apply plan whose stage writes planResult, and returns
// the plan metadata the runner posted.
func runApplyPlanJob(t *testing.T, planResult string) map[string]any {
	t.Helper()
	api := newCovRunAPI()
	w := NewWithAPI(Config{Operator: "self"}, api)
	w.sandbox = &covRunSandbox{onRun: func(spec sandbox.Spec) error {
		covRunWriteResult(t, spec.WorkDir, planResult)
		return nil
	}}
	stdout := NewJobLogger(api, "aplan-1", "STDOUT")
	stderr := NewJobLogger(api, "aplan-1", "STDERR")
	err := w.executePlan(t.Context(), &Job{ID: "aplan-1", JobType: string(types.JobTypePlan), ConfigSnapshot: covRunSnapshot()}, "aws", nil, nil, stdout, stderr)
	stdout.Close()
	stderr.Close()
	if err != nil {
		t.Fatalf("executePlan: %v", err)
	}
	for _, u := range api.getStatusUpdates() {
		if u.metadata["plan_completed"] == true {
			return u.metadata
		}
	}
	t.Fatal("the plan metadata was never posted")
	return nil
}

// An apply plan's posted resource changes keep each resource's identity, actions, non-sensitive
// known planned values and the unknown mask — and none of the values the plan marks sensitive or
// unknown, nor the prior state, nor the rest of the plan document.
func TestApplyPlanJob_PostsNoSensitiveOrUnknownValues(t *testing.T) {
	meta := runApplyPlanJob(t, applyPlanFixture)
	blob, err := json.Marshal(meta)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(blob), "never-posted") {
		t.Fatalf("the posted plan result carries a value it must not keep: %s", blob)
	}
	for _, field := range []string{"before", "after_sensitive", "variables"} {
		if strings.Contains(string(blob), `"`+field+`"`) {
			t.Errorf("the posted plan result must not carry %q: %s", field, blob)
		}
	}

	pr, _ := meta["plan_result"].(map[string]any)
	changes, _ := pr["resource_changes"].([]any)
	if len(changes) != 1 {
		t.Fatalf("want one resource change, got %v", pr)
	}
	rc, _ := changes[0].(map[string]any)
	for k, want := range map[string]any{
		"address": "aws_db_instance.main", "mode": "managed", "type": "aws_db_instance", "name": "main",
		"provider_name": "registry.opentofu.org/hashicorp/aws",
	} {
		if rc[k] != want {
			t.Errorf("%s = %v, want %v", k, rc[k], want)
		}
	}
	change, _ := rc["change"].(map[string]any)
	if !reflect.DeepEqual(change["actions"], []any{"update"}) {
		t.Errorf("actions = %v, want [update]", change["actions"])
	}
	wantAfter := map[string]any{
		"engine": "postgres", "port": float64(5432),
		"settings": map[string]any{"region": "eu-west-1"},
		"users":    []any{map[string]any{"name": "app"}, map[string]any{"name": "admin"}},
	}
	if !reflect.DeepEqual(change["after"], wantAfter) {
		t.Errorf("after = %#v, want %#v", change["after"], wantAfter)
	}
	wantUnknown := map[string]any{"arn": true, "endpoint": true}
	if !reflect.DeepEqual(change["after_unknown"], wantUnknown) {
		t.Errorf("after_unknown = %#v, want %#v", change["after_unknown"], wantUnknown)
	}
}

// A plan with no resource_changes key records its format_version and nothing else of the document.
func TestApplyPlanJob_NoChangePlanKeepsOnlyFormatVersion(t *testing.T) {
	meta := runApplyPlanJob(t, `{"PlanJSON":{"format_version":"1.2","variables":{"db_password":{"value":"var-secret-never-posted"}},"prior_state":{"values":{"x":"state-never-posted"}}}}`)
	want := map[string]any{"format_version": "1.2"}
	if !reflect.DeepEqual(meta["plan_result"], want) {
		t.Fatalf("plan_result = %#v, want %#v", meta["plan_result"], want)
	}
}

// plannedValue drops a value whose mask does not fit its shape rather than guess, and keeps array
// positions when it drops an element.
func TestPlannedValue_Shapes(t *testing.T) {
	cases := []struct {
		name            string
		value           any
		sensitive, unkn any
		want            any
		keep            bool
	}{
		{"unmarked scalar", "x", nil, nil, "x", true},
		{"false mask", "x", false, false, "x", true},
		{"sensitive scalar", "x", true, nil, nil, false},
		{"unknown scalar", "x", nil, true, nil, false},
		{"object mask over a scalar", "x", map[string]any{"a": true}, nil, nil, false},
		{"array mask over an object", map[string]any{"a": "x"}, []any{true}, nil, nil, false},
		{"object mask over an array", []any{"x"}, nil, map[string]any{"a": true}, nil, false},
		{"array element dropped in place", []any{"a", "b", "c"}, []any{false, true}, nil, []any{"a", nil, "c"}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, keep := plannedValue(tc.value, tc.sensitive, tc.unkn)
			if keep != tc.keep || !reflect.DeepEqual(got, tc.want) {
				t.Errorf("plannedValue = (%#v, %v), want (%#v, %v)", got, keep, tc.want, tc.keep)
			}
		})
	}
}

// The unknown mask is copied as booleans only; anything else in it is dropped.
func TestBoolMask_KeepsOnlyBooleans(t *testing.T) {
	got, ok := boolMask(map[string]any{"a": true, "b": "not-a-flag", "c": []any{false, 7.0}})
	want := map[string]any{"a": true, "c": []any{false, nil}}
	if !ok || !reflect.DeepEqual(got, want) {
		t.Errorf("boolMask = (%#v, %v), want %#v", got, ok, want)
	}
}

// The parent reads the stage's result.json only as a regular file in the work directory: a
// symbolic link at that name is refused, never followed.
func TestReadPlanResult_RefusesASymlinkedResult(t *testing.T) {
	body := []byte(`{"plan_result":{"PlanJSON":{"format_version":"1.2"}}}`)

	t.Run("regular file is read", func(t *testing.T) {
		workDir := t.TempDir()
		if err := os.WriteFile(filepath.Join(workDir, "result.json"), body, 0o600); err != nil {
			t.Fatal(err)
		}
		pr, err := readPlanResult(workDir)
		if err != nil || pr == nil || pr.PlanJSON["format_version"] != "1.2" {
			t.Fatalf("readPlanResult = (%v, %v), want the plan", pr, err)
		}
	})

	t.Run("symlink is refused", func(t *testing.T) {
		workDir := t.TempDir()
		target := filepath.Join(t.TempDir(), "elsewhere.json")
		if err := os.WriteFile(target, body, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(target, filepath.Join(workDir, "result.json")); err != nil {
			t.Skipf("symlinks unavailable: %v", err)
		}
		if pr, err := readPlanResult(workDir); err == nil {
			t.Fatalf("a symlinked result.json must be refused, got %+v", pr)
		}
		// Every result.json reader goes through the same check.
		if _, err := readVerifyReport(workDir); err == nil {
			t.Error("readVerifyReport must refuse a symlinked result.json")
		}
	})

	t.Run("directory is refused", func(t *testing.T) {
		workDir := t.TempDir()
		if err := os.Mkdir(filepath.Join(workDir, "result.json"), 0o700); err != nil {
			t.Fatal(err)
		}
		if _, err := readPlanResult(workDir); err == nil || !strings.Contains(err.Error(), "not a regular file") {
			t.Fatalf("a non-regular result.json must be refused with a reason, got %v", err)
		}
	})
}
