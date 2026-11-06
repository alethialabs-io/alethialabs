// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"bytes"
	"context"
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// byoCluster is a scripted kubectl that succeeds at everything and keeps every manifest applied
// with `kubectl apply -f FILE`, in order, so a test can read back what reached the cluster.
type byoCluster struct{ applied string }

// newByoCluster installs the scripted kubectl. prior is a manifest already on the cluster from an
// EARLIER deploy; it is recorded first, as though an earlier run had applied it.
func newByoCluster(t *testing.T, prior string) *byoCluster {
	t.Helper()
	return newByoClusterFailing(t, prior, false)
}

// newByoClusterFailing is newByoCluster whose `kubectl apply` of an AppProject fails (and records
// nothing) when failAppProject is set — the case where a refused destination cannot be withdrawn.
func newByoClusterFailing(t *testing.T, prior string, failAppProject bool) *byoCluster {
	t.Helper()
	failGuard := ""
	if failAppProject {
		failGuard = "grep -q 'kind: AppProject' \"$3\" && exit 1; "
	}
	dir := t.TempDir()
	c := &byoCluster{applied: filepath.Join(dir, "applied.yaml")}
	if prior != "" {
		if err := os.WriteFile(c.applied, []byte(prior+"\n---\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	script := "#!/bin/sh\n" +
		"case \"$1 $2\" in\n" +
		"  'apply -f') " + failGuard + "cat \"$3\" >> '" + c.applied + "'; printf '\\n---\\n' >> '" + c.applied + "';;\n" +
		"esac\ncat >/dev/null 2>&1\nexit 0\n"
	provStubTool(t, "kubectl", script)
	return c
}

// byoDoc is the slice of an applied document these tests read.
type byoDoc struct {
	Kind     string `yaml:"kind"`
	Metadata struct {
		Name      string `yaml:"name"`
		Namespace string `yaml:"namespace"`
	} `yaml:"metadata"`
	Spec struct {
		Destinations []struct {
			Namespace string `yaml:"namespace"`
		} `yaml:"destinations"`
	} `yaml:"spec"`
}

// docs decodes every applied document, in apply order.
func (c *byoCluster) docs(t *testing.T) []byoDoc {
	t.Helper()
	raw, err := os.ReadFile(c.applied)
	if err != nil {
		t.Fatalf("nothing was applied: %v", err)
	}
	var out []byoDoc
	dec := yaml.NewDecoder(bytes.NewReader(raw))
	for {
		var d byoDoc
		if err := dec.Decode(&d); err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			t.Fatalf("an applied document did not parse: %v\n%s", err, raw)
		}
		if d.Kind != "" {
			out = append(out, d)
		}
	}
	return out
}

// lastAppProjectDestinations is the destination list of the LAST AppProject named name that reached
// the cluster. `kubectl apply` of a custom resource replaces a list field wholesale, so the last
// apply is the cluster's state.
func (c *byoCluster) lastAppProjectDestinations(t *testing.T, name string) []string {
	t.Helper()
	var last *byoDoc
	docs := c.docs(t)
	for i := range docs {
		if docs[i].Kind == "AppProject" && docs[i].Metadata.Name == name {
			last = &docs[i]
		}
	}
	if last == nil {
		t.Fatalf("no AppProject %s was ever applied", name)
	}
	out := []string{}
	for _, d := range last.Spec.Destinations {
		out = append(out, d.Namespace)
	}
	return out
}

// namespacesCreated is every Namespace the runner applied.
func (c *byoCluster) namespacesCreated(t *testing.T) []string {
	t.Helper()
	out := []string{}
	for _, d := range c.docs(t) {
		if d.Kind == "Namespace" {
			out = append(out, d.Metadata.Name)
		}
	}
	return out
}

// legacyByoConfig is a project with an ordinary BYO chart and a "legacy" chart attached before
// #6439, whose stored namespace is ns.
func legacyByoConfig(ns string) *types.ProjectConfig {
	return &types.ProjectConfig{
		ProjectName: "Acme Corp",
		AddOns: []types.AddOnInstall{
			{ID: "api", Mode: "managed", Source: "git", ChartRepo: "https://github.com/acme/charts.git", Path: "charts/api", Version: "HEAD", Namespace: "payments"},
			{ID: "legacy", Mode: "managed", Source: "git", ChartRepo: "https://github.com/acme/legacy.git", Path: "charts/legacy", Version: "HEAD", Namespace: ns},
		},
	}
}

// TestConfigureByoCharts_RefusesPerChartAndWithdrawsTheDestination is the deploy-time half of #6439.
//
// A chart attached before the rule still has its reserved namespace stored and reaches the runner
// unchanged. It is refused ON ITS OWN: the other chart in the project is still configured, the
// reserved namespace is never created, and the AppProject is re-applied listing only the accepted
// destination. The refusal names the chart and the namespace, and becomes the deploy warning.
func TestConfigureByoCharts_RefusesPerChartAndWithdrawsTheDestination(t *testing.T) {
	for _, ns := range []string{"kube-system", "argocd", "external-secrets-operator", "monitoring", "datadog", vclusterHostNamespacePrefix + "team-a"} {
		t.Run(ns, func(t *testing.T) {
			c := newByoCluster(t, "")
			vc := legacyByoConfig(ns)
			var errOut strings.Builder
			configured, refused, _ := byoConfigureTuple(configureByoCharts(vc, "tok", nil, nil, io.Discard, &errOut))
			if !configured {
				t.Fatal("one refused chart must not stop the project's other BYO chart from being configured")
			}
			if len(refused) != 1 || refused[0].ID != "legacy" || refused[0].Namespace != ns {
				t.Fatalf("refused = %+v, want exactly the legacy chart in %q", refused, ns)
			}
			msg := errOut.String()
			if !strings.Contains(msg, "refusing BYO chart") || !strings.Contains(msg, `"legacy"`) || !strings.Contains(msg, ns) {
				t.Errorf("the refusal must name the chart and %q, got:\n%s", ns, msg)
			}
			if w := refused[0].warning(); !strings.Contains(w, "not deployed") || !strings.Contains(w, ns) || !strings.Contains(w, "reserved") {
				t.Errorf("the deploy warning must say the chart was not deployed and why, got: %s", w)
			}
			if got := c.lastAppProjectDestinations(t, "byo-acme-corp"); !reflect.DeepEqual(got, []string{"payments"}) {
				t.Errorf("AppProject destinations = %v, want only the accepted chart's namespace", got)
			}
			if got := c.namespacesCreated(t); !reflect.DeepEqual(got, []string{"payments"}) {
				t.Errorf("namespaces created = %v, want only payments — the runner must not touch %q", got, ns)
			}
			for _, a := range vc.AddOns {
				if a.Project != "byo-acme-corp" {
					t.Errorf("AddOn %s Project = %q, want the hardened project", a.ID, a.Project)
				}
			}
		})
	}
}

// TestConfigureByoCharts_WithdrawsAReservedDestinationAnEarlierDeployGranted covers an environment
// that already exists: an earlier deploy applied the AppProject WITH the now-reserved destination.
// Even when every BYO chart is refused, the AppProject is re-applied, and what the cluster is left
// holding lists no destination at all — so ArgoCD refuses any further sync into that namespace,
// while the objects already there are left in place.
func TestConfigureByoCharts_WithdrawsAReservedDestinationAnEarlierDeployGranted(t *testing.T) {
	prior := "apiVersion: argoproj.io/v1alpha1\nkind: AppProject\nmetadata:\n  name: byo-acme-corp\n  namespace: argocd\n" +
		"spec:\n  destinations:\n    - namespace: kube-system\n      server: https://kubernetes.default.svc\n"
	c := newByoCluster(t, prior)
	if got := c.lastAppProjectDestinations(t, "byo-acme-corp"); !reflect.DeepEqual(got, []string{"kube-system"}) {
		t.Fatalf("fixture: the earlier deploy's AppProject should grant kube-system, got %v", got)
	}

	vc := legacyByoConfig("kube-system")
	vc.AddOns = vc.AddOns[1:] // only the legacy chart
	configured, refused, _ := byoConfigureTuple(configureByoCharts(vc, "tok", nil, nil, io.Discard, io.Discard))
	if configured {
		t.Error("with its only chart refused, nothing was configured — the result must say so")
	}
	if len(refused) != 1 {
		t.Fatalf("refused = %+v, want the legacy chart", refused)
	}
	if got := c.lastAppProjectDestinations(t, "byo-acme-corp"); len(got) != 0 {
		t.Errorf("after this deploy the AppProject still grants %v; the reserved destination must be withdrawn", got)
	}
}

// TestConfigureByoCharts_WarningSaysWhenTheDestinationCouldNotBeWithdrawn: when the AppProject
// apply fails, the destination an earlier deploy granted is still there, and the deploy warning must
// not claim otherwise.
func TestConfigureByoCharts_WarningSaysWhenTheDestinationCouldNotBeWithdrawn(t *testing.T) {
	newByoClusterFailing(t, "", true)
	_, refused, _ := byoConfigureTuple(configureByoCharts(legacyByoConfig("kube-system"), "tok", nil, nil, io.Discard, io.Discard))
	if len(refused) != 1 || refused[0].ProjectUpdated {
		t.Fatalf("refused = %+v, want one refusal whose project was NOT updated", refused)
	}
	w := refused[0].warning()
	if !strings.Contains(w, "could not update its project") || strings.Contains(w, "can no longer sync") {
		t.Errorf("with the AppProject apply failed, the warning must not claim the chart can no longer sync, got: %s", w)
	}

	newByoCluster(t, "")
	_, refused, _ = byoConfigureTuple(configureByoCharts(legacyByoConfig("kube-system"), "tok", nil, nil, io.Discard, io.Discard))
	if len(refused) != 1 || !refused[0].ProjectUpdated {
		t.Fatalf("refused = %+v, want one refusal whose project WAS updated", refused)
	}
	// True on a first deploy too, when there is no earlier Application: nothing claims there is one.
	if w := refused[0].warning(); !strings.Contains(w, "Anything an earlier deploy applied for it") || !strings.Contains(w, "This deploy applied nothing for it") {
		t.Errorf("the warning must be true whether or not an earlier deploy applied the chart, got: %s", w)
	}
}

// TestRunAddOnStage_LeavesTheRefusedChartOutOfEveryStep drives the REAL add-on stage RunDeployV2
// calls (runAddOnStage), against the scripted kubectl, with an ordinary BYO chart and one in a
// reserved namespace. The refused chart gets nothing — no secret, no binding, no Application, no place
// in the returned list the health wait reads — and a deploy warning naming it; the accepted chart gets
// all of them. Each filter in the stage is pinned here, render and wave apply together (see
// runAddOnStage).
func TestRunAddOnStage_LeavesTheRefusedChartOutOfEveryStep(t *testing.T) {
	c := newByoCluster(t, "")
	vc := legacyByoConfig("kube-system")
	// Both charts carry a seeded secret and a bound workload, so the secret-seeding and binding steps
	// are observable too.
	vc.EnvironmentID = "env-1"
	for i := range vc.AddOns {
		vc.AddOns[i].Workloads = byoBindingConfig("env-1", true).AddOns[0].Workloads
		vc.AddOns[i].SecretRef = &types.AddOnSecretRef{
			SecretName: "alethia-addon-" + vc.AddOns[i].ID,
			Namespace:  vc.AddOns[i].Namespace,
			StaticData: map[string]string{"user": "admin"},
		}
	}
	refreshed := []string{}
	stage, err := runAddOnStage(context.Background(), addOnStageInput{
		VC:             vc,
		Facts:          &argocd.InfraFacts{},
		Outputs:        map[string]interface{}{"rds_master_credentials_secret_name": bindingOutputsSecret},
		Provider:       "aws",
		GitAccessToken: "tok",
		Refresh: func(_ context.Context, step string) error {
			refreshed = append(refreshed, step)
			return nil
		},
	}, io.Discard, io.Discard)
	if err != nil {
		t.Fatalf("runAddOnStage: %v", err)
	}

	applied := map[string]bool{}
	seeded := map[string]bool{}
	bound := map[string]bool{}
	for _, d := range c.docs(t) {
		switch d.Kind {
		case "Application":
			applied[d.Metadata.Name] = true
		case "Secret":
			seeded[d.Metadata.Name] = true
		case "ExternalSecret":
			bound[d.Metadata.Namespace] = true
		}
	}
	if bound["kube-system"] {
		t.Error("a binding ExternalSecret was applied into the refused chart's reserved namespace")
	}
	if !bound["payments"] {
		t.Errorf("the accepted chart's binding was not applied; bound namespaces: %v", bound)
	}
	for _, d := range stage.Bindings.Declared {
		if d.Namespace == "kube-system" {
			t.Errorf("the refused chart's binding is still declared (%+v), so the prune would keep it", d)
		}
	}
	if seeded["alethia-addon-legacy"] {
		t.Error("a secret was seeded into the refused chart's reserved namespace")
	}
	if !seeded["alethia-addon-api"] {
		t.Errorf("the accepted chart's secret was not seeded; seeded: %v", seeded)
	}
	if applied[argocd.AddOnAppName("legacy")] {
		t.Error("the refused chart's Application was applied")
	}
	if !applied[argocd.AddOnAppName("api")] {
		t.Errorf("the accepted chart's Application was not applied; applied: %v", applied)
	}
	// The health wait RunDeployV2 runs after the prunes reads stage.Deployable.
	waitNames := argocd.AllAddOnNames(stage.Deployable)
	if containsName(waitNames, argocd.AddOnAppName("legacy")) {
		t.Errorf("the health wait would spend its budget on the refused chart: %v", waitNames)
	}
	if !containsName(waitNames, argocd.AddOnAppName("api")) {
		t.Errorf("the accepted chart would not be waited on: %v", waitNames)
	}
	if len(stage.Warnings) != 1 || !strings.Contains(stage.Warnings[0], `"legacy"`) {
		t.Errorf("want one deploy warning naming the refused chart, got %v", stage.Warnings)
	}
	if !reflect.DeepEqual(refreshed, []string{"the add-on Applications"}) {
		t.Errorf("credential refreshes = %v, want exactly one, before the wave apply", refreshed)
	}
	// What the prune that follows the stage keeps: the refused chart's Application is NOT deleted.
	if keep := argocd.ManagedAddOnNames(vc.AddOns); !containsName(keep, argocd.AddOnAppName("legacy")) {
		t.Errorf("the prune keep list %v omits the refused chart, so its live Application would be deleted", keep)
	}
}

// TestRunDeployV2_PrunesBeforeTheHealthWait pins the order RunDeployV2 has always had around the add-on
// stage: the stage, then every add-on prune, then the health wait. A disabled add-on's Application
// must be gone before the wait measures the one replacing it, and a failed re-mint before the wait
// must not skip the prunes. It also pins that the wait reads the stage's `deployable`, so a refused
// BYO chart is not waited on. Read from the syntax tree, so a call moved into a closure or an `if` is
// still located.
func TestRunDeployV2_PrunesBeforeTheHealthWait(t *testing.T) {
	fset := token.NewFileSet()
	parsed, err := parser.ParseFile(fset, "deploy.go", nil, 0)
	if err != nil {
		t.Fatalf("could not parse deploy.go, so this guard proved nothing: %v", err)
	}
	var body *ast.BlockStmt
	for _, decl := range parsed.Decls {
		if d, ok := decl.(*ast.FuncDecl); ok && d.Name.Name == "RunDeployV2" && d.Recv == nil {
			body = d.Body
		}
	}
	if body == nil {
		t.Fatal("RunDeployV2 was not found in deploy.go — this guard proved nothing")
	}
	pos := map[string]token.Pos{}
	waitReadsDeployable := false
	ast.Inspect(body, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		// The wait must read the stage's `deployable`, not vc.AddOns: argocd.AllAddOnNames(deployable).
		if f, ok := call.Fun.(*ast.SelectorExpr); ok && f.Sel.Name == "WaitAddOnsHealthy" && len(call.Args) > 1 {
			if inner, ok := call.Args[1].(*ast.CallExpr); ok && len(inner.Args) == 1 {
				if arg, ok := inner.Args[0].(*ast.Ident); ok && arg.Name == "deployable" {
					waitReadsDeployable = true
				}
			}
		}
		name := ""
		switch f := call.Fun.(type) {
		case *ast.Ident:
			name = f.Name
		case *ast.SelectorExpr:
			if pkg, ok := f.X.(*ast.Ident); ok {
				name = pkg.Name + "." + f.Sel.Name
			}
		}
		if _, seen := pos[name]; name != "" && !seen {
			pos[name] = call.Pos()
		}
		return true
	})
	prunes := []string{
		"argocd.PruneManagedAddOns", "pruneByoChartBindings", "argocd.PruneAddOnSecrets",
		"argocd.PruneRegistryPullSecrets", "argocd.PruneHelmRepoCredentials", "argocd.PruneHelmRepoRefreshers",
	}
	for _, name := range append([]string{"runAddOnStage", "argocd.WaitAddOnsHealthy"}, prunes...) {
		if _, ok := pos[name]; !ok {
			t.Fatalf("%s is not called in RunDeployV2 — this guard proved nothing about the order", name)
		}
	}
	if !waitReadsDeployable {
		t.Error("argocd.WaitAddOnsHealthy no longer reads AllAddOnNames(deployable), so a refused BYO chart would be waited on")
	}
	for _, p := range prunes {
		if pos[p] < pos["runAddOnStage"] {
			t.Errorf("%s runs before the add-on stage", p)
		}
		if pos[p] > pos["argocd.WaitAddOnsHealthy"] {
			t.Errorf("%s runs AFTER argocd.WaitAddOnsHealthy: the wait would measure what the prune removes", p)
		}
	}
}

// TestByoBindings_ARefusedChartsBindingSecretsAreWithdrawnWithIt: a refused chart's binding secrets are
// withdrawn with it (deliberately, even though its running workloads lose the credential — see
// declaredByoBindings) — the owner-scoped prune deletes the one an earlier deploy applied, and nothing
// new is applied. The control: the same binding on an
// ACCEPTED chart is kept. (The refusal is passed directly here; which namespaces are refused is
// covered by the tests above.)
func TestByoBindings_ARefusedChartsBindingSecretsAreWithdrawnWithIt(t *testing.T) {
	live := liveBinding(`{"alethia.io/byo-binding":"true","alethia.io/environment-id":"env-1"}`)
	outputs := map[string]interface{}{"rds_master_credentials_secret_name": bindingOutputsSecret}

	t.Run("refused chart: withdrawn", func(t *testing.T) {
		c := newBindingCluster(t, live, 0)
		vc := byoBindingConfig("env-1", true)
		vc.AddOns[0].Source = "git"
		st := applyByoChartBindingsExcept(vc, outputs, "aws", []byoRefusal{{ID: "acme-api", Namespace: "apps"}}, byoDBUsersOutcome{}, io.Discard, io.Discard)
		pruneByoChartBindings(st, io.Discard, io.Discard)
		if _, err := os.Stat(c.applied); err == nil {
			t.Error("a binding ExternalSecret was applied for a refused chart")
		}
		if !strings.Contains(c.calls(), bindingDelete) {
			t.Errorf("the refused chart's earlier binding was not withdrawn:\n%s", c.calls())
		}
	})
	t.Run("accepted chart: kept", func(t *testing.T) {
		c := newBindingCluster(t, live, 0)
		vc := byoBindingConfig("env-1", true)
		vc.AddOns[0].Source = "git"
		st := applyByoChartBindingsExcept(vc, outputs, "aws", nil, byoDBUsersOutcome{}, io.Discard, io.Discard)
		pruneByoChartBindings(st, io.Discard, io.Discard)
		if strings.Contains(c.calls(), "delete") {
			t.Errorf("an accepted chart's binding was deleted:\n%s", c.calls())
		}
	})
}

// TestByoReservedPrefixCoversVClusterHostNamespaces pins the "vcluster-" prefix in
// packages/core/argocd/byo_reserved_namespaces.json to the constant that actually names a virtual
// cluster's host namespace, which lives here rather than in argocd.
func TestByoReservedPrefixCoversVClusterHostNamespaces(t *testing.T) {
	if err := argocd.ValidateByoNamespace(vclusterHostNamespacePrefix + "x"); err == nil || !strings.Contains(err.Error(), "reserved") {
		t.Fatalf("a vcluster host namespace (%q+name) must be reserved for BYO charts, got %v", vclusterHostNamespacePrefix, err)
	}
}

// containsName reports whether want is in list.
func containsName(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}
