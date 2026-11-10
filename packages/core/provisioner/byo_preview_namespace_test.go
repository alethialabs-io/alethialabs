// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"context"
	"io"
	"reflect"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// previewOverlapConfig is legacyByoConfig whose project's preview namespaces start with "pr", and
// whose legacy chart is stored in ns.
func previewOverlapConfig(ns string) *types.ProjectConfig {
	vc := legacyByoConfig(ns)
	vc.PreviewNamespacePrefix = "pr"
	return vc
}

// TestConfigureByoCharts_ReportsAChartInAPreviewNamespaceAndKeepsDeployingIt is the deploy-time half of
// #6494. A chart stored in one of the project's preview namespaces is REPORTED: it is not refused (so
// its bindings stay in the prune's keep set), not moved (so its Services keep their address), and its
// namespace stays a destination of the hardened project. A namespace that only shares the prefix's
// letters is not reported at all.
func TestConfigureByoCharts_ReportsAChartInAPreviewNamespaceAndKeepsDeployingIt(t *testing.T) {
	c := newByoCluster(t, "")
	vc := previewOverlapConfig("pr-7")
	var errOut strings.Builder
	got := configureByoCharts(vc, "tok", nil, nil, io.Discard, &errOut)
	if len(got.Refused) != 0 || len(got.Moved) != 0 {
		t.Fatalf("a chart in a preview namespace must be neither refused nor moved: refused=%+v moved=%+v", got.Refused, got.Moved)
	}
	if len(got.PreviewOverlaps) != 1 || got.PreviewOverlaps[0].ID != "legacy" || got.PreviewOverlaps[0].Namespace != "pr-7" {
		t.Fatalf("PreviewOverlaps = %+v, want exactly the legacy chart in pr-7", got.PreviewOverlaps)
	}
	if dests := c.lastAppProjectDestinations(t, "byo-acme-corp"); !reflect.DeepEqual(dests, []string{"payments", "pr-7"}) {
		t.Errorf("AppProject destinations = %v, want both charts' namespaces: the reported chart keeps deploying", dests)
	}
	if !strings.Contains(errOut.String(), `"legacy"`) || !strings.Contains(errOut.String(), `"pr-7"`) {
		t.Errorf("the deploy log must name the chart and its namespace, got:\n%s", errOut.String())
	}
	w := got.PreviewOverlaps[0].warning()
	for _, want := range []string{`"legacy"`, `"pr-7"`, `"pr"`, `"pr-"`, "was deployed", "binding secrets unchanged", "preview namespace prefix", `"byo-legacy"`} {
		if !strings.Contains(w, want) {
			t.Errorf("the Deploy-tab warning must contain %q, got: %s", want, w)
		}
	}

	t.Run("a namespace that only shares the prefix's letters is not reported", func(t *testing.T) {
		newByoCluster(t, "")
		got := configureByoCharts(previewOverlapConfig("pre-7"), "tok", nil, nil, io.Discard, io.Discard)
		if len(got.PreviewOverlaps) != 0 {
			t.Errorf("pre-7 reported against prefix pr: %+v", got.PreviewOverlaps)
		}
	})
	t.Run("a project with no preview configuration reports nothing", func(t *testing.T) {
		newByoCluster(t, "")
		vc := previewOverlapConfig("preview-7")
		vc.PreviewNamespacePrefix = ""
		got := configureByoCharts(vc, "tok", nil, nil, io.Discard, io.Discard)
		if len(got.PreviewOverlaps) != 0 {
			t.Errorf("reported with no preview prefix: %+v", got.PreviewOverlaps)
		}
	})
}

// TestRunAddOnStage_AChartInAPreviewNamespaceIsWarnedAboutAndStillDeployed drives the whole add-on stage:
// the overlap becomes a Deploy-tab warning, and the chart is in every step a deployed chart is in — its
// Application applied, its binding applied and DECLARED (the prune's keep set, so nothing withdraws its
// secrets), and the health wait's Deployable list.
func TestRunAddOnStage_AChartInAPreviewNamespaceIsWarnedAboutAndStillDeployed(t *testing.T) {
	c := newByoCluster(t, "")
	vc := previewOverlapConfig("pr-7")
	vc.EnvironmentID = "env-1"
	for i := range vc.AddOns {
		vc.AddOns[i].Workloads = byoBindingConfig("env-1", true).AddOns[0].Workloads
	}
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
	if len(stage.Warnings) != 1 || !strings.Contains(stage.Warnings[0], `"pr-7"`) || !strings.Contains(stage.Warnings[0], "preview") {
		t.Errorf("want one Deploy-tab warning naming the preview namespace, got %v", stage.Warnings)
	}
	applied, bound := false, false
	for _, d := range c.docs(t) {
		if d.Kind == "Application" && d.Metadata.Name == argocd.AddOnAppName("legacy") {
			applied = true
		}
		if d.Kind == "ExternalSecret" && d.Metadata.Namespace == "pr-7" {
			bound = true
		}
	}
	if !applied || !bound {
		t.Errorf("the reported chart must still deploy: Application applied=%v, binding applied=%v", applied, bound)
	}
	declared := false
	for _, d := range stage.Bindings.Declared {
		if d.Namespace == "pr-7" {
			declared = true
		}
	}
	if !declared {
		t.Error("the reported chart's binding is not declared, so the prune would withdraw its secrets from running pods")
	}
	deployable := false
	for _, a := range stage.Deployable {
		if a.ID == "legacy" {
			deployable = true
		}
	}
	if !deployable {
		t.Error("the reported chart is missing from Deployable")
	}
}
