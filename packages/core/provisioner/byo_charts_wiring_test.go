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
	"github.com/alethialabs-io/alethialabs/packages/core/manifests"
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
	return `{"items":[{"apiVersion":"external-secrets.io/v1beta1","metadata":{"name":"api-database-primary","namespace":"apps","uid":"0f8fad5b-d9cb-469f-a165-70867728950e","labels":` + labels + `}}]}`
}

// bindingDelete is the uid-pinned delete of api-database-primary in "apps".
const bindingDelete = "delete --raw /apis/external-secrets.io/v1beta1/namespaces/apps/externalsecrets/api-database-primary"

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

	if !strings.Contains(c.calls(), bindingDelete) {
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

// passwordBinding binds workload api's DB_PASSWORD to database db at value-path <db>.existingSecret.
func passwordBinding(db string) (types.ServiceBinding, string, string) {
	return types.ServiceBinding{
		Target: types.ServiceBindingTarget{Kind: types.ServiceBindingKindDatabase, Name: db},
		Inject: []types.ServiceBindingInjection{{Env: "DB_PASSWORD", From: "password"}},
	}, "bind:database:" + db + ":password", db + ".existingSecret"
}

// appliedDocs parses every ExternalSecret the scripted cluster received, keyed by name.
func appliedDocs(t *testing.T, c *bindingCluster) map[string]map[string]interface{} {
	t.Helper()
	out := map[string]map[string]interface{}{}
	body, err := os.ReadFile(c.applied)
	if err != nil {
		return out
	}
	dec := yaml.NewDecoder(strings.NewReader(string(body)))
	for {
		var doc map[string]interface{}
		if err := dec.Decode(&doc); err != nil {
			break
		}
		meta, _ := doc["metadata"].(map[string]interface{})
		name, _ := meta["name"].(string)
		out[name] = meta
	}
	return out
}

// keylessConfig is env-1 with one BYO workload in "apps" bound by password to each named database;
// iam marks which of them have iam_auth on.
func keylessConfig(iam map[string]bool, dbs ...string) *types.ProjectConfig {
	w := types.ChartWorkloadBinding{Name: "api", ValuePaths: map[string]string{}}
	var databases []types.ProjectDatabaseConfig
	for _, db := range dbs {
		b, knob, path := passwordBinding(db)
		w.Bindings = append(w.Bindings, b)
		w.ValuePaths[knob] = path
		databases = append(databases, types.ProjectDatabaseConfig{Name: db, IamAuth: boolPtr(iam[db])})
	}
	return &types.ProjectConfig{
		ID: "proj-1", EnvironmentID: "env-1", Databases: databases,
		AddOns: []types.AddOnInstall{{ID: "acme-api", Namespace: "apps", Workloads: []types.ChartWorkloadBinding{w}}},
	}
}

// TestByoBindingKeyless covers BYO bindings following the service lane's keyless decision: with the
// flag on, a keyless database target gets no password secret (no ExternalSecret, no value-path patch,
// a reported reason, and not declared); with it off, the same target keeps the password path; a mixed
// config splits per database.
func TestByoBindingKeyless(t *testing.T) {
	cases := []struct {
		name        string
		flag        string
		iam         map[string]bool
		dbs         []string
		wantApplied []string
		wantRefused []string
	}{
		{name: "keyless on", flag: "true", iam: map[string]bool{"primary": true}, dbs: []string{"primary"}, wantRefused: []string{"primary"}},
		{name: "keyless off", flag: "", iam: map[string]bool{"primary": true}, dbs: []string{"primary"}, wantApplied: []string{"primary"}},
		{name: "mixed", flag: "true", iam: map[string]bool{"primary": true}, dbs: []string{"primary", "reports"},
			wantApplied: []string{"reports"}, wantRefused: []string{"primary"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("ALETHIA_KEYLESS_DB_AUTH_ENABLED", tc.flag)
			c := newBindingCluster(t, `{"items":[]}`, 0)
			vc := keylessConfig(tc.iam, tc.dbs...)
			var log strings.Builder
			st := applyByoChartBindings(vc, map[string]interface{}{"rds_master_credentials_secret_name": bindingOutputsSecret}, "aws", &log, io.Discard)

			applied := appliedDocs(t, c)
			declared := map[string]bool{}
			for _, d := range st.Declared {
				declared[d.Name] = true
			}
			values := vc.AddOns[0].Values
			for _, db := range tc.wantApplied {
				name := "api-database-" + db
				if applied[name] == nil {
					t.Errorf("%s: no ExternalSecret applied for the password-mode database", db)
				}
				if !declared[name] {
					t.Errorf("%s: a password-mode binding is not declared", db)
				}
				if m, _ := values[db].(map[string]interface{}); m == nil || m["existingSecret"] != name {
					t.Errorf("%s: value path not patched: %#v", db, values[db])
				}
			}
			for _, db := range tc.wantRefused {
				name := "api-database-" + db
				if applied[name] != nil {
					t.Errorf("%s: an ExternalSecret was applied for a keyless database target", db)
				}
				if declared[name] {
					t.Errorf("%s: a keyless binding was declared (an earlier password secret would be kept)", db)
				}
				if _, patched := values[db]; patched {
					t.Errorf("%s: the value path was patched for a keyless database target: %#v", db, values[db])
				}
				if !strings.Contains(log.String(), "bind:database:"+db+":password unsatisfied (keyless database") {
					t.Errorf("%s: the keyless refusal was not reported:\n%s", db, log.String())
				}
			}
		})
	}
}

// TestByoBindingEmptyEnvironmentIDAppliesNothing: with no environment ID the ExternalSecret could not
// carry an owner label, so it is not applied at all, no value path points at it, and the reason is
// reported.
func TestByoBindingEmptyEnvironmentIDAppliesNothing(t *testing.T) {
	c := newBindingCluster(t, `{"items":[]}`, 0)
	vc := byoBindingConfig("", true)
	var log strings.Builder
	st := applyByoChartBindings(vc, map[string]interface{}{"rds_master_credentials_secret_name": bindingOutputsSecret}, "aws", &log, io.Discard)

	if strings.Contains(c.calls(), "apply") {
		t.Fatalf("an ExternalSecret was applied for an environment with no ID:\n%s", c.calls())
	}
	if _, patched := vc.AddOns[0].Values["api"]; patched {
		t.Errorf("a value path was patched to a Secret that will not exist: %#v", vc.AddOns[0].Values)
	}
	if !strings.Contains(log.String(), "the environment has no ID") {
		t.Errorf("the refusal was not reported:\n%s", log.String())
	}
	if st.Failures != 0 {
		t.Errorf("a policy refusal is not a failure, got %d", st.Failures)
	}
}

// TestByoBindingRefusesAServiceOwnedSecretName: a BYO add-on in the service lane's namespace whose
// binding resolves to a Secret name a first-class service renders is refused (no apply, no patch,
// reason reported), and stays DECLARED so the prune can never remove that name.
func TestByoBindingRefusesAServiceOwnedSecretName(t *testing.T) {
	c := newBindingCluster(t, `{"items":[]}`, 0)
	b, knob, path := passwordBinding("primary")
	vc := &types.ProjectConfig{
		ID: "proj-1", EnvironmentID: "env-1",
		Services: []types.ProjectServiceConfig{{Name: "api", Bindings: []types.ServiceBinding{b}}},
		AddOns: []types.AddOnInstall{{ID: "acme-api", Workloads: []types.ChartWorkloadBinding{{
			Name: "api", Bindings: []types.ServiceBinding{b}, ValuePaths: map[string]string{knob: path},
		}}}},
	}
	var log strings.Builder
	st := applyByoChartBindings(vc, map[string]interface{}{"rds_master_credentials_secret_name": bindingOutputsSecret}, "aws", &log, io.Discard)

	if strings.Contains(c.calls(), "apply") {
		t.Fatalf("the runner applied over a service's ExternalSecret:\n%s", c.calls())
	}
	if _, patched := vc.AddOns[0].Values["primary"]; patched {
		t.Errorf("a value path was patched: %#v", vc.AddOns[0].Values)
	}
	if !strings.Contains(log.String(), "already rendered by a first-class service") {
		t.Errorf("the refusal was not reported:\n%s", log.String())
	}
	want := argocd.BindingSecretRef{Namespace: "default", Name: "api-database-primary"}
	if len(st.Declared) != 1 || st.Declared[0] != want {
		t.Errorf("Declared = %#v, want the refused name kept as %#v", st.Declared, want)
	}

	// The same workload in its own namespace is not the service's object, and applies.
	c2 := newBindingCluster(t, `{"items":[]}`, 0)
	vc.AddOns[0].Namespace = "apps"
	vc.AddOns[0].Values = nil
	applyByoChartBindings(vc, map[string]interface{}{"rds_master_credentials_secret_name": bindingOutputsSecret}, "aws", io.Discard, io.Discard)
	if appliedDocs(t, c2)["api-database-primary"] == nil {
		t.Errorf("a binding outside the service namespace was refused:\n%s", c2.calls())
	}
}

// TestByoBindingDeclaredRefMatchesTheRenderedObjectInDefault: an add-on with no namespace renders
// into "default", and the declared ref names exactly that object — the prune's keep set and the
// object on the cluster agree.
func TestByoBindingDeclaredRefMatchesTheRenderedObjectInDefault(t *testing.T) {
	c := newBindingCluster(t, `{"items":[]}`, 0)
	vc := byoBindingConfig("env-1", true)
	vc.AddOns[0].Namespace = ""
	st := applyByoChartBindings(vc, map[string]interface{}{"rds_master_credentials_secret_name": bindingOutputsSecret}, "aws", io.Discard, io.Discard)

	docs := appliedDocs(t, c)
	if len(docs) != 1 || len(st.Declared) != 1 {
		t.Fatalf("applied %d, declared %#v; want one of each", len(docs), st.Declared)
	}
	meta := docs[st.Declared[0].Name]
	if meta == nil {
		t.Fatalf("declared %q but applied %v", st.Declared[0].Name, docs)
	}
	if ns, _ := meta["namespace"].(string); ns != "default" || st.Declared[0].Namespace != "default" {
		t.Errorf("rendered namespace %q, declared %q; want both \"default\"", ns, st.Declared[0].Namespace)
	}
	if want := manifests.BindingSecretName("api", types.ServiceBindingTarget{Kind: types.ServiceBindingKindDatabase, Name: "primary"}); st.Declared[0].Name != want {
		t.Errorf("declared name %q, want %q", st.Declared[0].Name, want)
	}
}

// dbUserTarget is the database byoBindingConfig binds.
var dbUserTarget = types.ServiceBindingTarget{Kind: types.ServiceBindingKindDatabase, Name: "primary"}

// dbUserOutputs are a deploy's outputs carrying both the administrative secret and the binding's own
// key, so a test can see which one the binding read.
func dbUserOutputs() map[string]interface{} {
	return map[string]interface{}{
		"rds_master_credentials_secret_name": bindingOutputsSecret,
		"custom_secret_names": map[string]interface{}{
			manifests.ByoBindingDBSecretKey("env-1", "apps", "api", dbUserTarget): "use1-dev-acme-alethia-byo-db-x",
		},
	}
}

// provisionedDBUsers stands in for a BYO users run (runByoDBUsers) that provisioned users.
func provisionedDBUsers(users ...string) byoDBUsersOutcome {
	out := byoDBUsersOutcome{Provisioned: map[string]bool{}}
	for _, u := range users {
		out.Provisioned[u] = true
	}
	return out
}

// TestByoBindingDBUsers_NothingProvisionedWithdrawsTheAdminBinding: with the flag on and no user
// provisioned (a BYO users run that provisioned nothing), the database credential facet is
// unsatisfied with its reason, nothing is applied or patched, and the live ExternalSecret an earlier
// deploy pointed at the administrative credential is deleted although the binding is still declared.
func TestByoBindingDBUsers_NothingProvisionedWithdrawsTheAdminBinding(t *testing.T) {
	t.Setenv("ALETHIA_BYO_DB_USERS_ENABLED", "true")
	c := newBindingCluster(t, liveBinding(`{"alethia.io/byo-binding":"true","alethia.io/environment-id":"env-1"}`), 0)
	vc := byoBindingConfig("env-1", true)
	var log strings.Builder
	st := applyByoChartBindings(vc, dbUserOutputs(), "aws", &log, io.Discard)
	pruneByoChartBindings(st, io.Discard, io.Discard)

	if strings.Contains(c.calls(), "apply") {
		t.Fatalf("an ExternalSecret was applied with no user provisioned:\n%s", c.calls())
	}
	if _, patched := vc.AddOns[0].Values["api"]; patched {
		t.Errorf("a value path was patched to a Secret that will not exist: %#v", vc.AddOns[0].Values)
	}
	if !strings.Contains(log.String(), "own database user was not provisioned") {
		t.Errorf("the reason was not reported:\n%s", log.String())
	}
	want := argocd.BindingSecretRef{Namespace: "apps", Name: "api-database-primary", Source: argocd.ByoBindingSourceDBUser}
	if len(st.Declared) != 1 || st.Declared[0] != want {
		t.Errorf("Declared = %#v, want %#v", st.Declared, want)
	}
	if !strings.Contains(c.calls(), bindingDelete) {
		t.Errorf("the administrative binding ExternalSecret was not withdrawn:\n%s", c.calls())
	}
}

// TestByoBindingDBUsers_KeepsALiveOwnUserBinding: the control — a live ExternalSecret that already
// reads the binding's own user is kept.
func TestByoBindingDBUsers_KeepsALiveOwnUserBinding(t *testing.T) {
	t.Setenv("ALETHIA_BYO_DB_USERS_ENABLED", "true")
	c := newBindingCluster(t, liveBinding(`{"alethia.io/byo-binding":"true","alethia.io/environment-id":"env-1","alethia.io/byo-binding-source":"db-user"}`), 0)
	runBindingDeploy(byoBindingConfig("env-1", true), io.Discard)
	if strings.Contains(c.calls(), "delete") {
		t.Fatalf("a binding reading its own user was pruned:\n%s", c.calls())
	}
}

// TestByoBindingDBUsers_ProvisionedUserIsBound: with the user provisioned, the applied ExternalSecret
// reads the binding's own key under the same Secret name, carries the marker, owner and source
// labels as strings, never names the administrative secret, and the value path points at it.
func TestByoBindingDBUsers_ProvisionedUserIsBound(t *testing.T) {
	t.Setenv("ALETHIA_BYO_DB_USERS_ENABLED", "true")
	users := provisionedDBUsers(manifests.ByoBindingDBUser("env-1", "apps", "api", dbUserTarget))
	c := newBindingCluster(t, `{"items":[]}`, 0)
	vc := byoBindingConfig("env-1", true)
	st := applyByoChartBindingsExcept(vc, dbUserOutputs(), "aws", nil, users, io.Discard, io.Discard)

	body, err := os.ReadFile(c.applied)
	if err != nil {
		t.Fatalf("nothing was applied: %v\n%s", err, c.calls())
	}
	if strings.Contains(string(body), bindingOutputsSecret) {
		t.Fatalf("the BYO binding names the administrative secret:\n%s", body)
	}
	if !strings.Contains(string(body), "key: \"use1-dev-acme-alethia-byo-db-x\"") {
		t.Fatalf("the binding does not read its own key:\n%s", body)
	}
	meta := appliedDocs(t, c)["api-database-primary"]
	labels, _ := meta["labels"].(map[string]interface{})
	for key, want := range map[string]string{
		argocd.ByoBindingSecretLabel: "true", argocd.ByoBindingOwnerLabel: "env-1", argocd.ByoBindingSourceLabel: argocd.ByoBindingSourceDBUser,
	} {
		if got, ok := labels[key].(string); !ok || got != want {
			t.Errorf("label %s = %#v, want the string %q", key, labels[key], want)
		}
	}
	if m, _ := vc.AddOns[0].Values["api"].(map[string]interface{}); m == nil || m["existingSecret"] != "api-database-primary" {
		t.Errorf("value path not patched: %#v", vc.AddOns[0].Values)
	}
	if st.Failures != 0 {
		t.Errorf("failures = %d", st.Failures)
	}
}

// TestByoBindingDBUsers_FlagOffIsUnchanged: with the flag off the binding still reads the
// administrative secret and is declared with no source, exactly as before this mode existed.
func TestByoBindingDBUsers_FlagOffIsUnchanged(t *testing.T) {
	t.Setenv("ALETHIA_BYO_DB_USERS_ENABLED", "")
	users := provisionedDBUsers(manifests.ByoBindingDBUser("env-1", "apps", "api", dbUserTarget))
	c := newBindingCluster(t, `{"items":[]}`, 0)
	st := applyByoChartBindingsExcept(byoBindingConfig("env-1", true), dbUserOutputs(), "aws", nil, users, io.Discard, io.Discard)
	body, _ := os.ReadFile(c.applied)
	if !strings.Contains(string(body), bindingOutputsSecret) || strings.Contains(string(body), "alethia-byo-db-") {
		t.Fatalf("flag off changed what the binding reads:\n%s", body)
	}
	if len(st.Declared) != 1 || st.Declared[0].Source != "" {
		t.Errorf("Declared = %#v, want no source", st.Declared)
	}
}

// TestCustomSecretNames reads the tofu map output in both decoded shapes and ignores the rest.
func TestCustomSecretNames(t *testing.T) {
	for name, tc := range map[string]struct {
		in   interface{}
		want map[string]string
	}{
		"json map":    {map[string]interface{}{"a": "x", "b": 3, "c": ""}, map[string]string{"a": "x"}},
		"string map":  {map[string]string{"a": "x", "c": ""}, map[string]string{"a": "x"}},
		"absent":      {nil, map[string]string{}},
		"wrong shape": {"a", map[string]string{}},
	} {
		t.Run(name, func(t *testing.T) {
			got := customSecretNames(map[string]interface{}{"custom_secret_names": tc.in})
			if len(got) != len(tc.want) || (len(tc.want) > 0 && got["a"] != tc.want["a"]) {
				t.Fatalf("got %#v, want %#v", got, tc.want)
			}
		})
	}
}
