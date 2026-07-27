// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Guards for the plan-only teardown path (#1495). These assert the REFUSALS, which is where
// the risk lives: RunDestroyPlan and RunDestroy differ by one boolean, and the failure mode of
// getting it wrong is destroying real infrastructure on a call that asked a question.
//
// A real destroy plan needs a cloud, remote state and an OpenTofu binary, so the happy path
// belongs to the main-gated nightly (test/e2e/t2_day2_offer_run_test.go). Everything reachable
// without a cloud is asserted here.

package provisioner

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// TestRunDestroyRejectsDryRun pins the fail-closed rule: DryRun means "do not touch anything",
// so the call that always applies must REFUSE it rather than ignore it. Ignoring the flag would
// tear down real infrastructure on a caller that asked only to plan.
func TestRunDestroyRejectsDryRun(t *testing.T) {
	err := RunDestroy(context.Background(), DestroyParams{
		DryRun:        true,
		ProjectConfig: &types.ProjectConfig{ProjectName: "p", EnvironmentStage: types.EnvironmentStage("dev")},
		Provider:      "aws",
		TemplatesDir:  t.TempDir(),
		StateBackend:  &cloud.HTTPBackendConfig{ConsoleURL: "http://127.0.0.1:1", JobID: "j", Token: "tok"},
		Stdout:        io.Discard,
		Stderr:        io.Discard,
	})
	if err == nil {
		t.Fatal("RunDestroy accepted DryRun — a dry-run flag must never reach the apply path")
	}
	if !strings.Contains(err.Error(), "RunDestroyPlan") {
		t.Errorf("the refusal should point at RunDestroyPlan, got: %v", err)
	}
}

// TestRunDestroyPlanRequiresDryRun is the same guard from the other side: planning a teardown is
// an explicit act. Without the flag the caller has not said which of the two operations it wants,
// and defaulting is how the wrong one gets run.
func TestRunDestroyPlanRequiresDryRun(t *testing.T) {
	plan, err := RunDestroyPlan(context.Background(), DestroyParams{
		ProjectConfig: &types.ProjectConfig{ProjectName: "p", EnvironmentStage: types.EnvironmentStage("dev")},
		Provider:      "aws",
		TemplatesDir:  t.TempDir(),
		StateBackend:  &cloud.HTTPBackendConfig{ConsoleURL: "http://127.0.0.1:1", JobID: "j", Token: "tok"},
		Stdout:        io.Discard,
		Stderr:        io.Discard,
	})
	if err == nil {
		t.Fatal("RunDestroyPlan ran without DryRun set")
	}
	if plan != nil {
		t.Errorf("a rejected plan must return nil, got %#v", plan)
	}
}

// TestRunDestroyPlanVclusterOwnsNoTofu pins the honest-empty distinction. A vcluster placement is
// an app on a shared Fabric: it owns no state, so there is no teardown to plan. Returning an empty
// plan would be read by AnalyzeDay2 as "a teardown that changes nothing" — the opposite finding,
// and a silent pass on the gate.
func TestRunDestroyPlanVclusterOwnsNoTofu(t *testing.T) {
	plan, err := RunDestroyPlan(context.Background(), DestroyParams{
		DryRun: true,
		ProjectConfig: &types.ProjectConfig{
			ProjectName:      "p",
			EnvironmentStage: types.EnvironmentStage("dev"),
			PlacementMode:    types.PlacementModeVcluster,
		},
		Provider:     "aws",
		TemplatesDir: t.TempDir(),
		StateBackend: &cloud.HTTPBackendConfig{ConsoleURL: "http://127.0.0.1:1", JobID: "j", Token: "tok"},
		Stdout:       io.Discard,
		Stderr:       io.Discard,
	})
	if !errors.Is(err, ErrDestroyPlanNoTofu) {
		t.Fatalf("want ErrDestroyPlanNoTofu (a typed 'nothing to tear down'), got: %v", err)
	}
	if plan != nil {
		t.Errorf("want a nil plan alongside the typed error, got %#v", plan)
	}
}

// TestPrepareDestroyWorkdirValidates covers the shared setup's own preconditions — the checks
// RunDestroy used to make inline before RunDestroyPlan started sharing them.
func TestPrepareDestroyWorkdirValidates(t *testing.T) {
	cases := []struct {
		name   string
		params DestroyParams
		want   string
	}{
		{
			name:   "no project config",
			params: DestroyParams{StateBackend: &cloud.HTTPBackendConfig{}},
			want:   "ProjectConfig is required",
		},
		{
			name:   "no state backend",
			params: DestroyParams{ProjectConfig: &types.ProjectConfig{ProjectName: "p"}},
			want:   "StateBackend config is required",
		},
		{
			name: "no templates dir and not BYO IaC",
			params: DestroyParams{
				ProjectConfig: &types.ProjectConfig{ProjectName: "p"},
				StateBackend:  &cloud.HTTPBackendConfig{ConsoleURL: "http://127.0.0.1:1"},
			},
			want: "TemplatesDir is required",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			wd, err := prepareDestroyWorkdir(context.Background(), tc.params)
			if err == nil {
				t.Fatalf("want an error containing %q, got a workdir", tc.want)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("want an error containing %q, got: %v", tc.want, err)
			}
			if wd != nil {
				t.Errorf("a failed setup must return no workdir, got %#v", wd)
			}
		})
	}
}
