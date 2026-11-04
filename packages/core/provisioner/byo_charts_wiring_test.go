// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"gopkg.in/yaml.v3"
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

	st := applyByoChartBindings(vc, outputs, "aws", io.Discard, io.Discard)
	if len(st.Declared) != 0 || st.Failures != 0 {
		t.Fatalf("state = %#v, want no declared binding Secret (no credential facet was bound)", st)
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
	st := applyByoChartBindings(vc, map[string]interface{}{}, "aws", &log, io.Discard)
	if len(st.Declared) != 0 || st.Failures != 0 {
		t.Fatalf("state = %#v, want no declared binding Secret", st)
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

// bindingCluster is a scripted `kubectl` standing in for one cluster during a deploy's binding
// apply + prune: it records every call, captures applied manifests, fails `apply` on demand, and
// answers the ExternalSecret listing in "apps" with a fixed set of live objects. It deliberately
// IGNORES label selectors, so an owner check that relied on the API server alone would be caught.
type bindingCluster struct {
	log, applied string
}

// newBindingCluster installs the scripted kubectl. liveJSON is the `get externalsecrets -n apps`
// answer; applyExit is the exit code of every `kubectl apply`.
func newBindingCluster(t *testing.T, liveJSON string, applyExit int) *bindingCluster {
	t.Helper()
	dir := t.TempDir()
	c := &bindingCluster{log: filepath.Join(dir, "calls.log"), applied: filepath.Join(dir, "applied.yaml")}
	live := filepath.Join(dir, "live.json")
	if err := os.WriteFile(live, []byte(liveJSON), 0o600); err != nil {
		t.Fatal(err)
	}
	script := "#!/bin/sh\n" +
		"printf '%s\\n' \"$*\" >> '" + c.log + "'\n" +
		"case \"$*\" in\n" +
		"  apply*) cat \"$3\" >> '" + c.applied + "'; exit " + strconv.Itoa(applyExit) + ";;\n" +
		"  *'get namespaces'*) echo '{\"items\":[]}'; exit 0;;\n" +
		"  *'get externalsecrets -n apps'*) cat '" + live + "'; exit 0;;\n" +
		"esac\nexit 0\n"
	provStubTool(t, "kubectl", script)
	return c
}

// calls returns every recorded kubectl invocation.
func (c *bindingCluster) calls() string {
	b, _ := os.ReadFile(c.log)
	return string(b)
}

// byoBindingConfig is one environment with one BYO chart workload in "apps", optionally bound to a
// database through a credential facet.
func byoBindingConfig(envID string, bound bool) *types.ProjectConfig {
	w := types.ChartWorkloadBinding{Name: "api"}
	if bound {
		w.Bindings = []types.ServiceBinding{{
			Target: types.ServiceBindingTarget{Kind: types.ServiceBindingKindDatabase, Name: "primary"},
			Inject: []types.ServiceBindingInjection{{Env: "DB_PASSWORD", From: "password"}},
		}}
		w.ValuePaths = map[string]string{"bind:database:primary:password": "api.existingSecret"}
	}
	return &types.ProjectConfig{
		ID:            "proj-1",
		EnvironmentID: envID,
		AddOns:        []types.AddOnInstall{{ID: "acme-api", Namespace: "apps", Workloads: []types.ChartWorkloadBinding{w}}},
	}
}

// liveBinding is the cluster's listing of one api-database-primary ExternalSecret in "apps".
func liveBinding(labels string) string {
	return `{"items":[{"metadata":{"name":"api-database-primary","namespace":"apps","labels":` + labels + `}}]}`
}

const bindingOutputsSecret = "acme/rds/master"

// runBindingDeploy runs the binding half of a deploy: apply, then prune, as deploy.go does.
func runBindingDeploy(vc *types.ProjectConfig, stderr io.Writer) {
	st := applyByoChartBindings(vc, map[string]interface{}{"rds_master_credentials_secret_name": bindingOutputsSecret}, "aws", io.Discard, stderr)
	pruneByoChartBindings(st, io.Discard, stderr)
}

// TestByoBindingDeploy_AppliedObjectCarriesStringLabels: the ExternalSecret that reaches the cluster
// carries the marker and the owner label, both as strings once parsed.
func TestByoBindingDeploy_AppliedObjectCarriesStringLabels(t *testing.T) {
	c := newBindingCluster(t, `{"items":[]}`, 0)
	runBindingDeploy(byoBindingConfig("env-1", true), io.Discard)

	body, err := os.ReadFile(c.applied)
	if err != nil {
		t.Fatalf("no ExternalSecret was applied: %v", err)
	}
	var doc struct {
		Metadata struct {
			Labels map[string]interface{} `yaml:"labels"`
		} `yaml:"metadata"`
	}
	if err := yaml.Unmarshal(body, &doc); err != nil {
		t.Fatalf("applied manifest does not parse: %v\n%s", err, body)
	}
	for key, want := range map[string]string{argocd.ByoBindingSecretLabel: "true", argocd.ByoBindingOwnerLabel: "env-1"} {
		if got, ok := doc.Metadata.Labels[key].(string); !ok || got != want {
			t.Errorf("label %s = %#v, want the string %q\n%s", key, doc.Metadata.Labels[key], want, body)
		}
	}
}

// TestByoBindingDeploy_TransientApplyFailureKeepsTheLiveBinding: the binding is still declared, its
// apply fails this once, and the live ExternalSecret from the previous deploy survives — the prune
// does not even list.
func TestByoBindingDeploy_TransientApplyFailureKeepsTheLiveBinding(t *testing.T) {
	c := newBindingCluster(t, liveBinding(`{"alethia.io/byo-binding":"true","alethia.io/environment-id":"env-1"}`), 1)
	var errOut strings.Builder
	runBindingDeploy(byoBindingConfig("env-1", true), &errOut)

	if strings.Contains(c.calls(), "delete") {
		t.Fatalf("a binding whose apply failed was pruned:\n%s", c.calls())
	}
	if strings.Contains(c.calls(), "get externalsecrets") {
		t.Errorf("the prune ran on a deploy with a failed binding:\n%s", c.calls())
	}
	if !strings.Contains(errOut.String(), "skipping the BYO binding ExternalSecret prune") {
		t.Errorf("the skipped prune was not reported:\n%s", errOut.String())
	}
}

// TestByoBindingDeploy_RemovedDeclarationIsPruned: the workload no longer declares the binding, so
// this environment's live ExternalSecret for it is deleted.
func TestByoBindingDeploy_RemovedDeclarationIsPruned(t *testing.T) {
	c := newBindingCluster(t, liveBinding(`{"alethia.io/byo-binding":"true","alethia.io/environment-id":"env-1"}`), 0)
	runBindingDeploy(byoBindingConfig("env-1", false), io.Discard)

	if !strings.Contains(c.calls(), "delete externalsecret -n apps api-database-primary") {
		t.Fatalf("the removed binding was not pruned:\n%s", c.calls())
	}
}

// TestByoBindingDeploy_StillDeclaredBindingIsKept: the control for the case above — same live
// object, binding still declared, nothing deleted.
func TestByoBindingDeploy_StillDeclaredBindingIsKept(t *testing.T) {
	c := newBindingCluster(t, liveBinding(`{"alethia.io/byo-binding":"true","alethia.io/environment-id":"env-1"}`), 0)
	runBindingDeploy(byoBindingConfig("env-1", true), io.Discard)

	if strings.Contains(c.calls(), "delete") {
		t.Fatalf("a still-declared binding was pruned:\n%s", c.calls())
	}
	if !strings.Contains(c.calls(), "get externalsecrets -n apps") {
		t.Fatalf("the prune never listed the declared namespace:\n%s", c.calls())
	}
}

// TestByoBindingDeploy_ForeignAndUnownedObjectsAreUntouched: on a shared host another environment's
// labelled ExternalSecret, and a labelled one with no owner label at all, sit in the listed
// namespace. This environment declares nothing there, and still deletes neither.
func TestByoBindingDeploy_ForeignAndUnownedObjectsAreUntouched(t *testing.T) {
	for name, labels := range map[string]string{
		"foreign environment": `{"alethia.io/byo-binding":"true","alethia.io/environment-id":"env-2"}`,
		"no owner label":      `{"alethia.io/byo-binding":"true"}`,
	} {
		t.Run(name, func(t *testing.T) {
			c := newBindingCluster(t, liveBinding(labels), 0)
			runBindingDeploy(byoBindingConfig("env-1", false), io.Discard)
			if strings.Contains(c.calls(), "delete") {
				t.Fatalf("an object this environment does not own was pruned:\n%s", c.calls())
			}
		})
	}
}
