// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// TestApplyByoChartBindingsWritesNonSecretFacets drives the W5 Lane 2b binding write-back with a
// non-secret facet: the resolved endpoint lands at the declared chart-values path, and the add-on's
// Values map is created when the console left it nil.
func TestApplyByoChartBindingsWritesNonSecretFacets(t *testing.T) {
	vc := &types.ProjectConfig{
		AddOns: []types.AddOnInstall{
			// Skipped entirely: no described workloads.
			{ID: "grafana"},
			{
				ID:        "acme-api",
				Namespace: "apps",
				Workloads: []types.ChartWorkloadBinding{{
					Name: "api",
					Bindings: []types.ServiceBinding{{
						Target: types.ServiceBindingTarget{Kind: types.ServiceBindingKindDatabase, Name: "primary"},
						Inject: []types.ServiceBindingInjection{
							{Env: "DB_HOST", From: types.ServiceBindingFacetEndpoint},
						},
					}},
					ValuePaths: map[string]string{
						"bind:database:primary:endpoint": "api.env.dbHost",
					},
				}},
			},
		},
	}
	outputs := map[string]interface{}{
		"rds_cluster_endpoint": "primary.abc123.eu-central-1.rds.amazonaws.com",
		// A non-string output must be ignored by the string projection, not panic.
		"node_count": 3,
	}

	applied := applyByoChartBindings(vc, outputs, "aws", io.Discard, io.Discard)
	if len(applied) != 0 {
		t.Fatalf("applied = %#v, want none (no credential facet was bound)", applied)
	}
	values := vc.AddOns[1].Values
	if values == nil {
		t.Fatal("Values was left nil — the write-back must materialize the map")
	}
	api, ok := values["api"].(map[string]interface{})
	if !ok {
		t.Fatalf("values[api] = %#v, want a nested map", values["api"])
	}
	env, ok := api["env"].(map[string]interface{})
	if !ok {
		t.Fatalf("values[api][env] = %#v, want a nested map", api["env"])
	}
	if got := env["dbHost"]; got != "primary.abc123.eu-central-1.rds.amazonaws.com" {
		t.Fatalf("values[api][env][dbHost] = %#v, want the resolved endpoint", got)
	}
	if vc.AddOns[0].Values != nil {
		t.Error("a workload-less add-on had its Values touched")
	}
}

// TestApplyByoChartBindingsReportsUnsatisfiedKnobs pins the fail-closed half: a facet with no
// declared value-path is REPORTED and left unwritten, never guessed into the chart values.
func TestApplyByoChartBindingsReportsUnsatisfiedKnobs(t *testing.T) {
	vc := &types.ProjectConfig{
		AddOns: []types.AddOnInstall{{
			ID:        "acme-api",
			Namespace: "apps",
			Values:    map[string]interface{}{},
			Workloads: []types.ChartWorkloadBinding{{
				Name: "api",
				Bindings: []types.ServiceBinding{{
					Target: types.ServiceBindingTarget{Kind: types.ServiceBindingKindCache, Name: "sessions"},
					Inject: []types.ServiceBindingInjection{
						{Env: "CACHE_HOST", From: types.ServiceBindingFacetEndpoint},
					},
				}},
				// No ValuePaths at all — nothing is addressable.
			}},
		}},
	}

	var log strings.Builder
	applied := applyByoChartBindings(vc, map[string]interface{}{}, "aws", &log, io.Discard)
	if len(applied) != 0 {
		t.Fatalf("applied = %#v, want none", applied)
	}
	if len(vc.AddOns[0].Values) != 0 {
		t.Fatalf("Values = %#v, want untouched", vc.AddOns[0].Values)
	}
	if !strings.Contains(log.String(), "binding") || !strings.Contains(log.String(), "unsatisfied") {
		t.Fatalf("the unsatisfied knob was not reported: %q", log.String())
	}
}

// TestPrepareByoChartsNoByoCharts covers the early return: a project with only marketplace
// (Helm-registry) add-ons pins nothing to a hardened project and issues no command.
func TestPrepareByoChartsNoByoCharts(t *testing.T) {
	resetDeploySeams(t)
	executeCommand = func(string, string, []string, io.Writer, io.Writer) error {
		t.Error("prepareByoCharts shelled out for a project with no BYO charts")
		return nil
	}
	vc := &types.ProjectConfig{
		ProjectName: "acme",
		AddOns:      []types.AddOnInstall{{ID: "grafana", Chart: "grafana"}},
	}
	if prepareByoCharts(vc, "tok", nil, nil, io.Discard, io.Discard) {
		t.Fatal("prepareByoCharts reported BYO charts where there are none")
	}
	if vc.AddOns[0].Project != "" {
		t.Errorf("a marketplace add-on was pinned to %q — it must keep the infra project", vc.AddOns[0].Project)
	}
}

// TestPrepareByoChartsWarnsWithoutAToken covers the per-repo credential lane's no-token branch: a
// private BYO chart cannot sync, but the deploy must not fail (public charts still work).
func TestPrepareByoChartsWarnsWithoutAToken(t *testing.T) {
	resetDeploySeams(t)
	stubShellToolsOnPath(t)
	executeCommand = func(string, string, []string, io.Writer, io.Writer) error { return nil }

	vc := &types.ProjectConfig{
		ProjectName: "Acme Corp",
		AddOns: []types.AddOnInstall{{
			ID:        "acme-api",
			Source:    "git",
			ChartRepo: "https://github.com/acme/charts.git",
			Path:      "charts/api",
			// No Namespace — the pin must fall back to "default".
		}},
	}
	var errOut strings.Builder
	if !prepareByoCharts(vc, "", nil, map[string]string{"env": "prod"}, io.Discard, &errOut) {
		t.Fatal("prepareByoCharts did not report the BYO chart")
	}
	if vc.AddOns[0].Project != "byo-acme-corp" {
		t.Fatalf("BYO chart pinned to %q, want the hardened per-project AppProject", vc.AddOns[0].Project)
	}
	if !strings.Contains(errOut.String(), "no git access token for BYO repo") {
		t.Fatalf("stderr = %q, want the no-token warning", errOut.String())
	}
}

// fakeVClusterProvisioner records Deregister calls and returns a scripted error, so the teardown
// ordering is assertable without helm or a host cluster.
type fakeVClusterProvisioner struct {
	calls int
	err   error
}

// Create is unused by the teardown tests.
func (f *fakeVClusterProvisioner) Create(context.Context, VClusterSpec, io.Writer, io.Writer) error {
	return nil
}

// WaitReady is unused by the teardown tests.
func (f *fakeVClusterProvisioner) WaitReady(context.Context, VClusterSpec, time.Duration, io.Writer, io.Writer) error {
	return nil
}

// ResolveAPIServer is unused by the teardown tests.
func (f *fakeVClusterProvisioner) ResolveAPIServer(context.Context, VClusterSpec, io.Writer, io.Writer) (string, error) {
	return "", nil
}

// Deregister records the call and replays the scripted error.
func (f *fakeVClusterProvisioner) Deregister(context.Context, VClusterSpec, io.Writer, io.Writer) error {
	f.calls++
	return f.err
}

// TestDeregisterVClusterAttemptsBothTeardowns pins that the ArgoCD cluster-Secret deregistration is
// attempted even when the control-plane teardown failed — a leaked cluster Secret keeps a dead
// vcluster registered, which is the orphan hazard this ordering exists to avoid.
func TestDeregisterVClusterAttemptsBothTeardowns(t *testing.T) {
	stubShellToolsOnPath(t)
	spec := validVClusterSpec()

	prov := &fakeVClusterProvisioner{err: errors.New("helm uninstall failed")}
	var errOut strings.Builder
	err := deregisterVCluster(context.Background(), prov, spec, io.Discard, &errOut)
	if err == nil || !strings.Contains(err.Error(), "helm uninstall failed") {
		t.Fatalf("err = %v, want the first (control-plane) failure", err)
	}
	if prov.calls != 1 {
		t.Fatalf("Deregister called %d times, want 1", prov.calls)
	}
	if !strings.Contains(errOut.String(), "teardown (helm uninstall + exported Secret) failed") {
		t.Fatalf("stderr = %q, want the control-plane teardown warning", errOut.String())
	}

	clean := &fakeVClusterProvisioner{}
	if err := deregisterVCluster(context.Background(), clean, spec, io.Discard, io.Discard); err != nil {
		t.Fatalf("clean teardown returned %v", err)
	}
}
