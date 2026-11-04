// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"bytes"
	"errors"
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
	dir := t.TempDir()
	c := &byoCluster{applied: filepath.Join(dir, "applied.yaml")}
	if prior != "" {
		if err := os.WriteFile(c.applied, []byte(prior+"\n---\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	script := "#!/bin/sh\n" +
		"case \"$1 $2\" in\n" +
		"  'apply -f') cat \"$3\" >> '" + c.applied + "'; printf '\\n---\\n' >> '" + c.applied + "';;\n" +
		"esac\ncat >/dev/null 2>&1\nexit 0\n"
	provStubTool(t, "kubectl", script)
	return c
}

// byoDoc is the slice of an applied document these tests read.
type byoDoc struct {
	Kind     string `yaml:"kind"`
	Metadata struct {
		Name string `yaml:"name"`
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
			configured, refused := configureByoCharts(vc, "tok", nil, nil, io.Discard, &errOut)
			if !configured {
				t.Fatal("one refused chart must not stop the project's other BYO chart from being configured")
			}
			if len(refused) != 1 || refused[0].ID != "legacy" || refused[0].Namespace != ns {
				t.Fatalf("refused = %+v, want exactly the legacy chart in %q", refused, ns)
			}
			msg := errOut.String()
			if !strings.Contains(msg, "refusing to configure BYO charts") || !strings.Contains(msg, `"legacy"`) || !strings.Contains(msg, ns) {
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
	configured, refused := configureByoCharts(vc, "tok", nil, nil, io.Discard, io.Discard)
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

// TestByoRefusal_DeployStepRendersNothingForTheRefusedChartAndDeletesNothing runs the add-on stage in
// the order deploy.go does — configure, bindings, the `deployable` filter, render — and checks what a
// refused chart gets: no Application rendered (so none is applied, and the live one is not updated),
// no wait on its health, and still a place in the prune's keep list, so the live Application is not
// deleted as a "disabled" add-on. BOUNDARY: deploy.go itself is not driven (it needs a real
// provision); this is the same sequence of the same functions, and the filter is one helper used at
// every call site.
func TestByoRefusal_DeployStepRendersNothingForTheRefusedChartAndDeletesNothing(t *testing.T) {
	newByoCluster(t, "")
	vc := legacyByoConfig("kube-system")
	_, refused := configureByoCharts(vc, "tok", nil, nil, io.Discard, io.Discard)
	applyByoChartBindingsExcept(vc, map[string]interface{}{}, "aws", byoRefusedIDs(refused), io.Discard, io.Discard)

	deployable := withoutByoRefusals(vc.AddOns, refused)
	dir, err := argocd.RenderManagedAddOns(deployable, nil)
	if err != nil {
		t.Fatalf("RenderManagedAddOns: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	if _, err := os.Stat(filepath.Join(dir, argocd.AddOnAppName("legacy")+".yaml")); err == nil {
		t.Error("the refused chart's Application was rendered, so the deploy would apply it")
	}
	if _, err := os.Stat(filepath.Join(dir, argocd.AddOnAppName("api")+".yaml")); err != nil {
		t.Errorf("the accepted chart's Application was not rendered: %v", err)
	}
	if names := argocd.AllAddOnNames(deployable); contains(names, argocd.AddOnAppName("legacy")) {
		t.Errorf("the health wait would spend its budget on the refused chart: %v", names)
	}
	if keep := argocd.ManagedAddOnNames(vc.AddOns); !contains(keep, argocd.AddOnAppName("legacy")) {
		t.Errorf("the prune keep list %v omits the refused chart, so its live Application would be deleted", keep)
	}
}

// TestApplyByoChartBindingsExcept_RefusedChartWritesNothingAndKeepsItsBinding: a refused chart's
// binding ExternalSecret is not re-applied into its namespace, and — because it is still declared —
// the prune leaves the one an earlier deploy applied in place.
func TestApplyByoChartBindingsExcept_RefusedChartWritesNothingAndKeepsItsBinding(t *testing.T) {
	c := newBindingCluster(t, liveBinding(`{"alethia.io/byo-binding":"true","alethia.io/environment-id":"env-1"}`), 0)
	vc := byoBindingConfig("env-1", true)
	vc.AddOns[0].Source = "git"

	st := applyByoChartBindingsExcept(vc, map[string]interface{}{"rds_master_credentials_secret_name": bindingOutputsSecret}, "aws",
		map[string]bool{"acme-api": true}, io.Discard, io.Discard)
	pruneByoChartBindings(st, io.Discard, io.Discard)

	if _, err := os.Stat(c.applied); err == nil {
		t.Error("a binding ExternalSecret was applied for a refused chart")
	}
	if len(st.Declared) == 0 {
		t.Error("the refused chart's binding is no longer declared, so the prune would delete it")
	}
	if strings.Contains(c.calls(), "delete") {
		t.Errorf("the refused chart's live binding was deleted:\n%s", c.calls())
	}
}

// TestByoReservedPrefixCoversVClusterHostNamespaces pins the "vcluster-" prefix in
// packages/core/argocd/byo_reserved_namespaces.json to the constant that actually names a virtual
// cluster's host namespace, which lives here rather than in argocd.
func TestByoReservedPrefixCoversVClusterHostNamespaces(t *testing.T) {
	if err := argocd.ValidateByoNamespace(vclusterHostNamespacePrefix + "x"); err == nil || !strings.Contains(err.Error(), "reserved") {
		t.Fatalf("a vcluster host namespace (%q+name) must be reserved for BYO charts, got %v", vclusterHostNamespacePrefix, err)
	}
}

// contains reports whether want is in list.
func contains(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}
