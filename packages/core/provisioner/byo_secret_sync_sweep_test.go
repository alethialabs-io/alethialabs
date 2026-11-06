// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"bytes"
	"context"
	"io"
	"os"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
)

// lastRendered is the rendered-document map the stubbed sweep was last handed.
var lastRendered map[argocd.BindingSecretRef]string

// stubSweep replaces the cluster call for one test and records what it was handed.
func stubSweep(t *testing.T) *[][]argocd.BindingSecretRef {
	t.Helper()
	var got [][]argocd.BindingSecretRef
	orig := sweepByoSecretSyncObjects
	sweepByoSecretSyncObjects = func(owner string, declared []argocd.BindingSecretRef, rendered map[argocd.BindingSecretRef]string, _, _ io.Writer) []string {
		got = append(got, declared)
		lastRendered = rendered
		return []string{"deleted one"}
	}
	t.Cleanup(func() { sweepByoSecretSyncObjects = orig })
	return &got
}

// TestSweepByoSecretSync_SkipsWhenABindingFailed: the keep set is the declared bindings, and a
// binding that failed may be one the runner applied on an earlier deploy, so any failure skips the
// sweep outright and says so on the Deploy tab.
func TestSweepByoSecretSync_SkipsWhenABindingFailed(t *testing.T) {
	got := stubSweep(t)
	var stdout, stderr bytes.Buffer
	w := sweepByoSecretSync(byoBindingState{Owner: "env-1", Failures: 1}, nil, &stdout, &stderr)
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
	w := sweepByoSecretSync(byoBindingState{Owner: "env-1", Declared: declared}, nil, &stdout, &stderr)
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
	for _, d := range stage.Bindings.Declared {
		if lastRendered[d] == "" {
			t.Errorf("the sweep was not handed the rendered document for %+v: %v", d, lastRendered)
		}
	}
	if !strings.Contains(strings.Join(stage.Warnings, "\n"), "deleted one") {
		t.Errorf("the sweep's warning did not reach the Deploy tab: %q", stage.Warnings)
	}
}

// TestRenderedByoBindings_MatchesWhatTheBindingApplyApplies holds renderedByoBindings to the documents
// applyByoChartBindingsExcept actually applies, byte for byte. The sweep restores a live binding to
// the rendered document, so a renderer that drifted from the apply would rewrite every binding on
// every deploy.
func TestRenderedByoBindings_MatchesWhatTheBindingApplyApplies(t *testing.T) {
	c := newBindingCluster(t, `{"items":[]}`, 0)
	vc := byoBindingConfig("env-1", true)
	worker := vc.AddOns[0].Workloads[0]
	worker.Name = "worker"
	vc.AddOns[0].Workloads = append(vc.AddOns[0].Workloads, worker)
	outputs := map[string]interface{}{"rds_master_credentials_secret_name": bindingOutputsSecret}

	applyByoChartBindingsExcept(vc, outputs, "aws", nil, io.Discard, io.Discard)
	raw, err := os.ReadFile(c.applied)
	if err != nil {
		t.Fatalf("nothing was applied: %v", err)
	}
	applied := string(raw)

	rendered := renderedByoBindings(vc, outputs, "aws", nil)
	if len(rendered) != 2 {
		t.Fatalf("rendered %d binding(s), want 2: %v", len(rendered), rendered)
	}
	total := 0
	for ref, doc := range rendered {
		if !strings.Contains(applied, doc) {
			t.Errorf("the rendered %s/%s is not what the apply applied:\nrendered:\n%s\napplied:\n%s", ref.Namespace, ref.Name, doc, applied)
		}
		total += len(doc)
	}
	if total != len(applied) {
		t.Errorf("the apply applied %d bytes but the rendered documents are %d: one side has a document the other lacks", len(applied), total)
	}
}
