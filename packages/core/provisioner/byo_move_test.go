// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"bytes"
	"context"
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

// #6445 (OCI BYO charts take the hardened path) and #6446 (a BYO chart runs in its own namespace;
// "default" is reserved, and a chart already there moves on its next deploy).

// ociByoConfig is a project with an OCI BYO chart in ns and a catalogue chart from an OCI registry.
func ociByoConfig(ns string) *types.ProjectConfig {
	return &types.ProjectConfig{
		ProjectName: "Acme Corp",
		AddOns: []types.AddOnInstall{
			{ID: "payments", Mode: "managed", Source: "helm", Byo: true, ChartRepo: "oci://ghcr.io/acme", Chart: "payments", Version: "1.4.2", Namespace: ns},
			{ID: "catalogue-oci", Mode: "managed", Source: "helm", ChartRepo: "oci://registry.example.com/charts", Chart: "thing", Version: "2.0.0", Namespace: "thing"},
		},
	}
}

// appliedApp is the slice of an applied Application or AppProject these tests read.
type appliedApp struct {
	Kind     string `yaml:"kind"`
	Metadata struct {
		Name string `yaml:"name"`
	} `yaml:"metadata"`
	Spec struct {
		Project     string   `yaml:"project"`
		SourceRepos []string `yaml:"sourceRepos"`
		Destination struct {
			Namespace string `yaml:"namespace"`
		} `yaml:"destination"`
		SyncPolicy struct {
			Automated *struct {
				Prune    bool `yaml:"prune"`
				SelfHeal bool `yaml:"selfHeal"`
			} `yaml:"automated"`
		} `yaml:"syncPolicy"`
	} `yaml:"spec"`
}

// appliedObjects decodes every document a scripted kubectl recorded at path, by kind/name; a later
// apply of the same object wins, as it does on the cluster.
func appliedObjects(t *testing.T, path string) map[string]appliedApp {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("nothing was applied: %v", err)
	}
	out := map[string]appliedApp{}
	dec := yaml.NewDecoder(bytes.NewReader(raw))
	for {
		var d appliedApp
		if err := dec.Decode(&d); err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			t.Fatalf("an applied document did not parse: %v", err)
		}
		if d.Kind != "" {
			out[d.Kind+"/"+d.Metadata.Name] = d
		}
	}
	return out
}

// TestConfigureByoCharts_OCIByoChartTakesTheHardenedPath: an OCI BYO chart is pinned to byo-<slug>,
// its namespace is created and listed as the project's destination, and its registry is the project's
// allowed source. The catalogue OCI chart next to it is not touched. No git credential is registered
// against the registry URL.
func TestConfigureByoCharts_OCIByoChartTakesTheHardenedPath(t *testing.T) {
	c := newByoCluster(t, "")
	vc := ociByoConfig("payments")
	configured, refused, moved := configureByoCharts(vc, "tok", nil, nil, io.Discard, io.Discard)
	if !configured || len(refused) != 0 || len(moved) != 0 {
		t.Fatalf("configured=%v refused=%+v moved=%+v, want the OCI chart configured as it is", configured, refused, moved)
	}
	if vc.AddOns[0].Project != "byo-acme-corp" {
		t.Errorf("OCI BYO chart Project = %q, want byo-acme-corp", vc.AddOns[0].Project)
	}
	if vc.AddOns[1].Project != "" || vc.AddOns[1].Namespace != "thing" {
		t.Errorf("the catalogue OCI chart was changed: %+v", vc.AddOns[1])
	}
	if got := c.lastAppProjectDestinations(t, "byo-acme-corp"); !reflect.DeepEqual(got, []string{"payments"}) {
		t.Errorf("AppProject destinations = %v, want [payments]", got)
	}
	if got := c.namespacesCreated(t); !reflect.DeepEqual(got, []string{"payments"}) {
		t.Errorf("namespaces created = %v, want [payments]", got)
	}
	objs := appliedObjects(t, c.applied)
	if got := objs["AppProject/byo-acme-corp"].Spec.SourceRepos; !reflect.DeepEqual(got, []string{"oci://ghcr.io/acme"}) {
		t.Errorf("AppProject sourceRepos = %v, want only the OCI chart's registry", got)
	}
	if _, ok := objs["Secret/"+argocd.ByoRepoSecretName("oci://ghcr.io/acme")]; ok {
		t.Error("a git repository credential was registered against the OCI registry URL")
	}
}

// TestConfigureByoCharts_OCIByoChartInAReservedNamespaceIsRefused: the runner validates an OCI BYO
// chart's namespace too, so the console's check is not the only one.
func TestConfigureByoCharts_OCIByoChartInAReservedNamespaceIsRefused(t *testing.T) {
	c := newByoCluster(t, "")
	_, refused, _ := configureByoCharts(ociByoConfig("kube-system"), "tok", nil, nil, io.Discard, io.Discard)
	if len(refused) != 1 || refused[0].ID != "payments" || refused[0].Namespace != "kube-system" {
		t.Fatalf("refused = %+v, want the OCI chart in kube-system", refused)
	}
	if got := c.lastAppProjectDestinations(t, "byo-acme-corp"); len(got) != 0 {
		t.Errorf("AppProject destinations = %v, want none", got)
	}
}

// TestConfigureByoCharts_MovesAChartOutOfDefault: a chart attached with "default", or with no
// namespace (which deployed into "default"), moves to byo-<chart id>. The runner creates and lists
// the new namespace and never touches "default"; the project's destinations follow the move.
func TestConfigureByoCharts_MovesAChartOutOfDefault(t *testing.T) {
	for _, stored := range []string{"default", ""} {
		t.Run("stored="+stored, func(t *testing.T) {
			c := newByoCluster(t, "")
			vc := legacyByoConfig(stored)
			_, refused, moved := configureByoCharts(vc, "tok", nil, nil, io.Discard, io.Discard)
			if len(refused) != 0 {
				t.Fatalf("refused = %+v: a chart in default is moved, not refused", refused)
			}
			want := []byoMove{{ID: "legacy", From: "default", To: "byo-legacy"}}
			if !reflect.DeepEqual(moved, want) {
				t.Fatalf("moved = %+v, want %+v", moved, want)
			}
			if vc.AddOns[1].Namespace != "byo-legacy" {
				t.Errorf("the chart's namespace is %q, want byo-legacy for every later step", vc.AddOns[1].Namespace)
			}
			if vc.AddOns[0].Namespace != "payments" {
				t.Errorf("a chart with its own namespace was moved to %q", vc.AddOns[0].Namespace)
			}
			if got := c.lastAppProjectDestinations(t, "byo-acme-corp"); !reflect.DeepEqual(got, []string{"payments", "byo-legacy"}) {
				t.Errorf("AppProject destinations = %v, want [payments byo-legacy]", got)
			}
			if got := c.namespacesCreated(t); !reflect.DeepEqual(got, []string{"payments", "byo-legacy"}) {
				t.Errorf("namespaces created = %v, want [payments byo-legacy]", got)
			}
		})
	}
}

// TestByoMove_WarningNamesTheChartItsNewNamespaceAndWhatIsLeft: the Deploy-tab warning names the
// chart and its new namespace, says the resources in "default" are left in place and why, and says
// how to find them.
func TestByoMove_WarningNamesTheChartItsNewNamespaceAndWhatIsLeft(t *testing.T) {
	w := byoMove{ID: "legacy", From: "default", To: "byo-legacy"}.warning()
	for _, want := range []string{
		`"legacy"`, `"byo-legacy"`, `"default"`, "reserved for the platform",
		"not deleted", "delete them yourself", "argocd.argoproj.io/tracking-id", `"addon-legacy:"`,
		"binding secrets",
	} {
		if !strings.Contains(w, want) {
			t.Errorf("the warning does not say %q:\n%s", want, w)
		}
	}
}

// moveCluster is a scripted kubectl for a whole add-on stage plus the binding prune: it records every
// call and every applied manifest, and answers the ExternalSecret listing in "default" with live.
// Like bindingCluster it IGNORES label selectors, so the prune's own object re-check is what keeps a
// platform object safe.
type moveCluster struct{ log, applied string }

// newMoveCluster installs the scripted kubectl.
func newMoveCluster(t *testing.T, live string) *moveCluster {
	t.Helper()
	dir := t.TempDir()
	c := &moveCluster{log: filepath.Join(dir, "calls.log"), applied: filepath.Join(dir, "applied.yaml")}
	livePath := filepath.Join(dir, "live.json")
	if err := os.WriteFile(livePath, []byte(live), 0o600); err != nil {
		t.Fatal(err)
	}
	script := "#!/bin/sh\n" +
		"printf '%s\\n' \"$*\" >> '" + c.log + "'\n" +
		"case \"$*\" in\n" +
		"  'apply -f '*) cat \"$3\" >> '" + c.applied + "'; printf '\\n---\\n' >> '" + c.applied + "'; exit 0;;\n" +
		"  *'get namespaces'*) echo '{\"items\":[]}'; exit 0;;\n" +
		"  *'get externalsecrets -n default'*) cat '" + livePath + "'; exit 0;;\n" +
		"  *'get externalsecrets'*) echo '{\"items\":[]}'; exit 0;;\n" +
		"esac\ncat >/dev/null 2>&1\nexit 0\n"
	provStubTool(t, "kubectl", script)
	return c
}

// calls returns every recorded kubectl invocation.
func (c *moveCluster) calls() string {
	b, _ := os.ReadFile(c.log)
	return string(b)
}

// TestRunAddOnStage_AMovedChartDeploysInItsOwnNamespaceAndItsBindingsFollow drives the real add-on
// stage and the binding prune RunDeployV2 runs after it, for a chart attached in "default" with a
// bound workload whose binding an earlier deploy applied there:
//   - the Application is re-applied under the same name, into byo-legacy;
//   - the stage returns the move's warning;
//   - the binding ExternalSecret is applied in byo-legacy, and the one in "default" is withdrawn;
//   - a platform ExternalSecret in "default" — no binding marker, no owner label — is not touched.
func TestRunAddOnStage_AMovedChartDeploysInItsOwnNamespaceAndItsBindingsFollow(t *testing.T) {
	live := `{"items":[` +
		`{"apiVersion":"external-secrets.io/v1beta1","metadata":{"name":"api-database-primary","namespace":"default","uid":"0f8fad5b-d9cb-469f-a165-70867728950e","labels":{"alethia.io/byo-binding":"true","alethia.io/environment-id":"env-1"}}},` +
		`{"apiVersion":"external-secrets.io/v1beta1","metadata":{"name":"alethia-app-db","namespace":"default","uid":"1f8fad5b-d9cb-469f-a165-70867728950e","labels":{"app":"alethia-app"}}}` +
		`]}`
	c := newMoveCluster(t, live)
	vc := legacyByoConfig("default")
	vc.EnvironmentID = "env-1"
	vc.AddOns = vc.AddOns[1:] // only the legacy chart
	vc.AddOns[0].Workloads = byoBindingConfig("env-1", true).AddOns[0].Workloads

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
	pruneByoChartBindings(stage.Bindings, io.Discard, io.Discard)

	app, ok := appliedObjects(t, c.applied)["Application/"+argocd.AddOnAppName("legacy")]
	if !ok {
		t.Fatalf("the moved chart's Application was not applied under its own name")
	}
	if app.Spec.Destination.Namespace != "byo-legacy" || app.Spec.Project != "byo-acme-corp" {
		t.Errorf("Application destination=%q project=%q, want byo-legacy under byo-acme-corp", app.Spec.Destination.Namespace, app.Spec.Project)
	}
	if len(stage.Warnings) != 1 || !strings.Contains(stage.Warnings[0], `"byo-legacy"`) || !strings.Contains(stage.Warnings[0], `"legacy"`) {
		t.Errorf("want one warning naming the chart and its new namespace, got %v", stage.Warnings)
	}
	appliedRaw, _ := os.ReadFile(c.applied)
	if !strings.Contains(string(appliedRaw), "kind: ExternalSecret") || !strings.Contains(string(appliedRaw), "namespace: byo-legacy") {
		t.Errorf("the binding ExternalSecret was not applied in byo-legacy:\n%s", appliedRaw)
	}
	for _, d := range stage.Bindings.Declared {
		if d.Namespace != "byo-legacy" {
			t.Errorf("binding declared in %q, want byo-legacy: %+v", d.Namespace, d)
		}
	}
	calls := c.calls()
	if !strings.Contains(calls, "delete --raw /apis/external-secrets.io/v1beta1/namespaces/default/externalsecrets/api-database-primary") {
		t.Errorf("the binding an earlier deploy applied in default was not withdrawn:\n%s", calls)
	}
	if strings.Contains(calls, "alethia-app-db") {
		t.Errorf("a platform ExternalSecret in default was touched:\n%s", calls)
	}
	// Nothing else in "default" is deleted: the only delete is the uid-pinned binding withdrawal.
	for _, line := range strings.Split(calls, "\n") {
		if strings.Contains(line, "delete") && !strings.Contains(line, "/namespaces/default/externalsecrets/api-database-primary") {
			t.Errorf("unexpected delete: %s", line)
		}
	}
	// The prune that follows keeps the Application: same name, so nothing is deleted by the move.
	if keep := argocd.ManagedAddOnNames(vc.AddOns); !containsName(keep, argocd.AddOnAppName("legacy")) {
		t.Errorf("the prune keep list %v omits the moved chart", keep)
	}
}

// TestRunAddOnStage_AnOCIChartMovesOutOfInfraInPlace: an OCI BYO chart an earlier deploy applied under
// "infra" is re-applied under the SAME Application name — an in-place change of project, never a
// delete-and-create — with the hardened project and prune off in the same object. The catalogue OCI
// chart beside it keeps "infra" and its prune.
func TestRunAddOnStage_AnOCIChartMovesOutOfInfraInPlace(t *testing.T) {
	c := newMoveCluster(t, `{"items":[]}`)
	vc := ociByoConfig("payments")
	stage, err := runAddOnStage(context.Background(), addOnStageInput{
		VC:      vc,
		Facts:   &argocd.InfraFacts{},
		Refresh: func(context.Context, string) error { return nil },
	}, io.Discard, io.Discard)
	if err != nil {
		t.Fatalf("runAddOnStage: %v", err)
	}
	if len(stage.Refused) != 0 || len(stage.Warnings) != 0 {
		t.Fatalf("refused=%+v warnings=%v, want neither", stage.Refused, stage.Warnings)
	}
	objs := appliedObjects(t, c.applied)
	byo, ok := objs["Application/"+argocd.AddOnAppName("payments")]
	if !ok {
		t.Fatal("the OCI BYO chart's Application was not applied under its existing name")
	}
	if byo.Spec.Project != "byo-acme-corp" {
		t.Errorf("OCI BYO Application project = %q, want byo-acme-corp", byo.Spec.Project)
	}
	if a := byo.Spec.SyncPolicy.Automated; a == nil || a.Prune || a.SelfHeal {
		t.Errorf("OCI BYO Application automated = %+v, want auto-sync with prune and self-heal off", a)
	}
	cat := objs["Application/"+argocd.AddOnAppName("catalogue-oci")]
	if cat.Spec.Project != "infra" || cat.Spec.SyncPolicy.Automated == nil || !cat.Spec.SyncPolicy.Automated.Prune {
		t.Errorf("catalogue OCI Application = %+v, want infra with prune on", cat.Spec)
	}
	if strings.Contains(c.calls(), "delete") {
		t.Errorf("the stage deleted something:\n%s", c.calls())
	}
	if keep := argocd.ManagedAddOnNames(vc.AddOns); !containsName(keep, argocd.AddOnAppName("payments")) {
		t.Errorf("the prune keep list %v omits the OCI BYO chart", keep)
	}
}

// TestByoReserved_AppNamespaceIsReservedForThePlatformsWorkloads pins the platformWorkloads group in
// byo_reserved_namespaces.json to the namespace the first-class workloads actually run in.
func TestByoReserved_AppNamespaceIsReservedForThePlatformsWorkloads(t *testing.T) {
	err := argocd.ValidateByoNamespace(appNamespace)
	if err == nil || !strings.Contains(err.Error(), "workloads") {
		t.Fatalf("appNamespace %q must be reserved as the platform's workload namespace, got %v", appNamespace, err)
	}
	if appNamespace != argocd.ByoLegacyDefaultNamespace {
		t.Errorf("appNamespace = %q but the BYO move treats %q as the old shared namespace", appNamespace, argocd.ByoLegacyDefaultNamespace)
	}
}
