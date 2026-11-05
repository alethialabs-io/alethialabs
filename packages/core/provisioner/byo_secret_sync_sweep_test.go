// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"bytes"
	"context"
	"io"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
)

// stubSweep replaces the cluster call for one test and records what it was handed. reapply is what
// the stubbed sweep reports it replaced.
func stubSweep(t *testing.T, reapply ...argocd.BindingSecretRef) *[][]argocd.BindingSecretRef {
	t.Helper()
	var got [][]argocd.BindingSecretRef
	orig := sweepByoSecretSyncObjects
	sweepByoSecretSyncObjects = func(owner string, declared []argocd.BindingSecretRef, _, _ io.Writer) argocd.ByoSecretSyncSweep {
		got = append(got, declared)
		return argocd.ByoSecretSyncSweep{Warnings: []string{"deleted one"}, Reapply: reapply}
	}
	t.Cleanup(func() { sweepByoSecretSyncObjects = orig })
	return &got
}

// noReapply is a re-apply pass that must not run.
func noReapply(t *testing.T) func([]argocd.BindingSecretRef) byoBindingState {
	return func(names []argocd.BindingSecretRef) byoBindingState {
		t.Errorf("a re-apply ran for %v although nothing was replaced", names)
		return byoBindingState{}
	}
}

// TestSweepByoSecretSync_SkipsWhenABindingFailed: the keep set is the declared bindings, and a
// binding that failed may be one the runner applied on an earlier deploy, so any failure skips the
// sweep outright and says so on the Deploy tab.
func TestSweepByoSecretSync_SkipsWhenABindingFailed(t *testing.T) {
	got := stubSweep(t)
	var stdout, stderr bytes.Buffer
	w := sweepByoSecretSync(byoBindingState{Owner: "env-1", Failures: 1}, noReapply(t), &stdout, &stderr)
	if len(*got) != 0 {
		t.Fatalf("the sweep ran although a binding failed")
	}
	if len(w) != 1 || w[0] != sweepByoSecretSyncSkipped {
		t.Errorf("the skipped sweep was not reported on the Deploy tab: %q", w)
	}
}

// TestSweepByoSecretSync_PassesTheDeclaredBindings: with every binding applied the sweep runs over
// exactly the declared set and its warnings reach the Deploy tab.
func TestSweepByoSecretSync_PassesTheDeclaredBindings(t *testing.T) {
	got := stubSweep(t)
	declared := []argocd.BindingSecretRef{{Namespace: "byo-pay", Name: "api-db"}}
	var stdout, stderr bytes.Buffer
	w := sweepByoSecretSync(byoBindingState{Owner: "env-1", Declared: declared}, noReapply(t), &stdout, &stderr)
	if len(*got) != 1 || len((*got)[0]) != 1 || (*got)[0][0] != declared[0] {
		t.Fatalf("the sweep was not handed the declared bindings: %v", *got)
	}
	if len(w) != 1 || w[0] != "deleted one" {
		t.Errorf("the sweep's warnings did not come back: %q", w)
	}
}

// TestRunAddOnStage_SweepsAfterTheBindings drives the real add-on stage: the sweep runs once, over
// the bindings the stage declared, and its warnings reach the Deploy tab.
func TestRunAddOnStage_SweepsAfterTheBindings(t *testing.T) {
	newByoCluster(t, "")
	got := stubSweep(t)
	vc := byoBindingConfig("env-1", true)
	stage, err := runAddOnStage(context.Background(), addOnStageInput{
		VC:             vc,
		Facts:          &argocd.InfraFacts{},
		Outputs:        map[string]interface{}{"rds_master_credentials_secret_name": bindingOutputsSecret},
		Provider:       "aws",
		GitAccessToken: "tok",
		Refresh:        func(context.Context, string) error { return nil },
	}, io.Discard, io.Discard)
	if err != nil {
		t.Fatalf("runAddOnStage: %v", err)
	}
	if len(*got) != 1 {
		t.Fatalf("the sweep ran %d times, want once", len(*got))
	}
	if len((*got)[0]) == 0 || len((*got)[0]) != len(stage.Bindings.Declared) {
		t.Errorf("the sweep was handed %v, want the declared bindings %v", (*got)[0], stage.Bindings.Declared)
	}
	if !strings.Contains(strings.Join(stage.Warnings, "\n"), "deleted one") {
		t.Errorf("the sweep's warning did not reach the Deploy tab: %q", stage.Warnings)
	}
}

// TestRunAddOnStage_ReappliesAReplacedBinding: a binding the sweep replaced, because the live object
// was not exactly the runner's own, is applied again in the same stage, rendered clean, and nothing
// else is applied a second time.
func TestRunAddOnStage_ReappliesAReplacedBinding(t *testing.T) {
	c := newByoCluster(t, "")
	stubSweep(t, argocd.BindingSecretRef{Namespace: "apps", Name: "api-database-primary"})
	vc := byoBindingConfig("env-1", true)
	worker := vc.AddOns[0].Workloads[0]
	worker.Name = "worker"
	vc.AddOns[0].Workloads = append(vc.AddOns[0].Workloads, worker)

	stage, err := runAddOnStage(context.Background(), addOnStageInput{
		VC:             vc,
		Facts:          &argocd.InfraFacts{},
		Outputs:        map[string]interface{}{"rds_master_credentials_secret_name": bindingOutputsSecret},
		Provider:       "aws",
		GitAccessToken: "tok",
		Refresh:        func(context.Context, string) error { return nil },
	}, io.Discard, io.Discard)
	if err != nil {
		t.Fatalf("runAddOnStage: %v", err)
	}
	applied := map[string]int{}
	for _, d := range c.docs(t) {
		if d.Kind == "ExternalSecret" {
			applied[d.Metadata.Namespace+"/"+d.Metadata.Name]++
		}
	}
	if applied["apps/api-database-primary"] != 2 {
		t.Errorf("the replaced binding was applied %d time(s), want twice (the pass and the re-apply); applied: %v", applied["apps/api-database-primary"], applied)
	}
	if applied["apps/worker-database-primary"] != 1 {
		t.Errorf("a binding the sweep kept was applied %d time(s), want once; applied: %v", applied["apps/worker-database-primary"], applied)
	}
	if strings.Contains(stage.Warnings[len(stage.Warnings)-1], "could not apply it again") {
		t.Errorf("the re-apply reported a failure: %q", stage.Warnings)
	}
}
