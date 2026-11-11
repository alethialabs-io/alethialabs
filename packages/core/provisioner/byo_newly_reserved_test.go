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
)

// TestConfigureByoCharts_ReportsAChartInANewlyReservedNamespaceAndKeepsDeployingIt (#6551): a chart
// already attached in a name that only the groups #6551 added reserve is REPORTED and kept — not
// refused (its bindings stay in the prune's keep set) and not moved — exactly as #6494 treats a chart
// in a preview namespace.
func TestConfigureByoCharts_ReportsAChartInANewlyReservedNamespaceAndKeepsDeployingIt(t *testing.T) {
	for _, ns := range []string{"databases", "fluent-bit"} {
		t.Run(ns, func(t *testing.T) {
			c := newByoCluster(t, "")
			var errOut strings.Builder
			got := configureByoCharts(legacyByoConfig(ns), "tok", nil, nil, io.Discard, &errOut)
			if len(got.Refused) != 0 || len(got.Moved) != 0 {
				t.Fatalf("an attached chart in %q must be neither refused nor moved: refused=%+v moved=%+v", ns, got.Refused, got.Moved)
			}
			if len(got.NewlyReserved) != 1 || got.NewlyReserved[0].ID != "legacy" || got.NewlyReserved[0].Namespace != ns {
				t.Fatalf("NewlyReserved = %+v, want exactly the legacy chart in %q", got.NewlyReserved, ns)
			}
			if dests := c.lastAppProjectDestinations(t, "byo-acme-corp"); !reflect.DeepEqual(dests, []string{ns, "payments"}) && !reflect.DeepEqual(dests, []string{"payments", ns}) {
				t.Errorf("AppProject destinations = %v, want both charts' namespaces: the reported chart keeps deploying", dests)
			}
			w := got.NewlyReserved[0].warning()
			for _, want := range []string{`"legacy"`, `"` + ns + `"`, "now reserved", "binding secrets unchanged", `"byo-legacy"`} {
				if !strings.Contains(w, want) {
					t.Errorf("the Deploy-tab warning must contain %q, got: %s", want, w)
				}
			}
		})
	}
}

// TestConfigureByoCharts_StillRefusesAPreviouslyReservedNamespace is the other direction: a name an
// OLDER group reserves keeps its refusal, even where a #6551 group lists it too.
func TestConfigureByoCharts_StillRefusesAPreviouslyReservedNamespace(t *testing.T) {
	for _, ns := range []string{"argocd", "queues", "cert-manager"} {
		t.Run(ns, func(t *testing.T) {
			newByoCluster(t, "")
			got := configureByoCharts(legacyByoConfig(ns), "tok", nil, nil, io.Discard, io.Discard)
			if len(got.Refused) != 1 || got.Refused[0].ID != "legacy" {
				t.Fatalf("a chart in %q must still be refused, got refused=%+v reported=%+v", ns, got.Refused, got.NewlyReserved)
			}
			if len(got.NewlyReserved) != 0 {
				t.Errorf("%q is not newly reserved, got %+v", ns, got.NewlyReserved)
			}
		})
	}
}

// TestRunAddOnStage_AChartInANewlyReservedNamespaceIsWarnedAboutAndStillBound: on the stage, the chart
// gets one Deploy-tab warning, its Application is applied and its binding ExternalSecret is still
// written into its namespace — the secrets running workloads read are not withdrawn.
func TestRunAddOnStage_AChartInANewlyReservedNamespaceIsWarnedAboutAndStillBound(t *testing.T) {
	c := newByoCluster(t, "")
	vc := legacyByoConfig("databases")
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
	if len(stage.Warnings) != 1 || !strings.Contains(stage.Warnings[0], `"databases"`) || !strings.Contains(stage.Warnings[0], "now reserved") {
		t.Errorf("want one Deploy-tab warning naming the namespace, got %v", stage.Warnings)
	}
	applied, bound := false, false
	for _, d := range c.docs(t) {
		if d.Kind == "Application" && d.Metadata.Name == argocd.AddOnAppName("legacy") {
			applied = true
		}
		if d.Kind == "ExternalSecret" && d.Metadata.Namespace == "databases" {
			bound = true
		}
	}
	if !applied || !bound {
		t.Errorf("the chart must keep deploying and keep its bindings: Application applied=%v, ExternalSecret in databases=%v", applied, bound)
	}
}
