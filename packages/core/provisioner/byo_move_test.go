// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"bytes"
	"context"
	"errors"
	"fmt"
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

// byoConfigureTuple unpacks configureByoCharts' result for the tests written against its earlier
// three-value form.
func byoConfigureTuple(r byoConfigured) (bool, []byoRefusal, []byoMove) {
	return r.Configured, r.Refused, r.Moved
}

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
	configured, refused, moved := byoConfigureTuple(configureByoCharts(vc, "tok", nil, nil, io.Discard, io.Discard))
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
	_, refused, _ := byoConfigureTuple(configureByoCharts(ociByoConfig("kube-system"), "tok", nil, nil, io.Discard, io.Discard))
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
			_, refused, moved := byoConfigureTuple(configureByoCharts(vc, "tok", nil, nil, io.Discard, io.Discard))
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
		"binding secrets", "keep running in the platform's namespace until you delete them",
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
	return newMoveClusterWith(t, live, `{"metadata":{"name":"default","labels":{"kubernetes.io/metadata.name":"default"}}}`, "")
}

// newMoveClusterWith is newMoveCluster whose `get namespace default -o json` answers nsJSON and whose
// read of an Application's live spec.project answers liveProject.
func newMoveClusterWith(t *testing.T, live, nsJSON, liveProject string) *moveCluster {
	t.Helper()
	dir := t.TempDir()
	nsPath := filepath.Join(dir, "ns.json")
	if err := os.WriteFile(nsPath, []byte(nsJSON), 0o600); err != nil {
		t.Fatal(err)
	}
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
		"  *'get namespace default -o json'*) cat '" + nsPath + "'; exit 0;;\n" +
		"  *'get applications.argoproj.io'*) printf '%s' '" + liveProject + "'; exit 0;;\n" +
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

// TestConfigureByoCharts_ReleasesTheLegacyLabelsOnDefault: when this environment's charts move out
// of "default", the two labels an earlier runner stamped on it are removed — only those two keys,
// only with this environment's values — and nothing else on "default" is touched.
func TestConfigureByoCharts_ReleasesTheLegacyLabelsOnDefault(t *testing.T) {
	const remove = "label namespace default alethia.io/environment-id- alethia.io/managed-by-"
	for _, tc := range []struct {
		name, labels string
		want         string // the expected label call, "" for none
	}{
		{"ours", `{"kubernetes.io/metadata.name":"default","alethia.io/managed-by":"byo-charts","alethia.io/environment-id":"env-1","team":"x"}`, remove},
		{"another environment's", `{"alethia.io/managed-by":"byo-charts","alethia.io/environment-id":"env-2"}`, ""},
		{"managed-by someone else", `{"alethia.io/managed-by":"helm","alethia.io/environment-id":"env-1"}`, "label namespace default alethia.io/environment-id-"},
		{"never labelled", `{"kubernetes.io/metadata.name":"default"}`, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := newMoveClusterWith(t, `{"items":[]}`, `{"metadata":{"name":"default","labels":`+tc.labels+`}}`, "")
			vc := legacyByoConfig("default")
			vc.EnvironmentID = "env-1"
			configureByoCharts(vc, "tok", nil, nil, io.Discard, io.Discard)
			var labelCalls []string
			for _, line := range strings.Split(c.calls(), "\n") {
				// A server-side dry run (the Pod Security preview, #6495) changes no label.
				if strings.HasPrefix(line, "label ") && !strings.Contains(line, "--dry-run=server") {
					labelCalls = append(labelCalls, line)
				}
			}
			want := []string{}
			if tc.want != "" {
				want = []string{tc.want}
			}
			if labelCalls == nil {
				labelCalls = []string{}
			}
			if !reflect.DeepEqual(labelCalls, want) {
				t.Errorf("label calls = %q, want %q", labelCalls, want)
			}
		})
	}
	// No move, no read of "default" at all.
	c := newMoveCluster(t, `{"items":[]}`)
	vc := legacyByoConfig("payments")
	vc.EnvironmentID = "env-1"
	configureByoCharts(vc, "tok", nil, nil, io.Discard, io.Discard)
	if strings.Contains(c.calls(), "namespace default") {
		t.Errorf("default was read or edited with no chart moving out of it:\n%s", c.calls())
	}
}

// TestRunAddOnStage_WarnsWhenAnOCIChartLeavesAnotherProject: an OCI BYO chart whose live Application
// is under "infra" gets one Deploy-tab warning naming the chart, its hardened project and what that
// changes. Already under its hardened project, or never applied: no warning.
func TestRunAddOnStage_WarnsWhenAnOCIChartLeavesAnotherProject(t *testing.T) {
	for _, tc := range []struct {
		live string
		warn bool
	}{{"infra", true}, {"byo-acme-corp", false}, {"", false}} {
		t.Run("live="+tc.live, func(t *testing.T) {
			newMoveClusterWith(t, `{"items":[]}`, `{}`, tc.live)
			stage, err := runAddOnStage(context.Background(), addOnStageInput{
				VC: ociByoConfig("payments"), Facts: &argocd.InfraFacts{},
				Refresh: func(context.Context, string) error { return nil },
			}, io.Discard, io.Discard)
			if err != nil {
				t.Fatalf("runAddOnStage: %v", err)
			}
			if !tc.warn {
				if len(stage.Warnings) != 0 {
					t.Errorf("want no warning, got %v", stage.Warnings)
				}
				return
			}
			if len(stage.Warnings) != 1 {
				t.Fatalf("want one warning, got %v", stage.Warnings)
			}
			w := stage.Warnings[0]
			for _, want := range []string{`"payments"`, `"byo-acme-corp"`, `"infra"`, "ServiceAccount", "cluster-scoped", "closed list", "left in place"} {
				if !strings.Contains(w, want) {
					t.Errorf("the warning does not say %q:\n%s", want, w)
				}
			}
		})
	}
}

// TestConfigureByoCharts_KeepsAnExistingChosenByoNamespace: the "byo-" rule is an ATTACH-time rule.
// A chart that chose a "byo-" namespace before it — one no other chart in the environment derives —
// keeps deploying there.
func TestConfigureByoCharts_KeepsAnExistingChosenByoNamespace(t *testing.T) {
	c := newByoCluster(t, "")
	_, refused, _ := byoConfigureTuple(configureByoCharts(legacyByoConfig("byo-payments"), "tok", nil, nil, io.Discard, io.Discard))
	if len(refused) != 0 {
		t.Fatalf("an existing chart in byo-payments was refused: %+v", refused)
	}
	if got := c.lastAppProjectDestinations(t, "byo-acme-corp"); !reflect.DeepEqual(got, []string{"payments", "byo-payments"}) {
		t.Errorf("AppProject destinations = %v, want [payments byo-payments]", got)
	}
}

// collisionConfig is an environment where chart `explicit` chose byo-payments, which is chart
// "payments"'s own derived namespace, in the given add-on order.
func collisionConfig(explicit string, explicitFirst bool) *types.ProjectConfig {
	// The owner is stored with its own derived namespace, as a chart attached after #6446 is. (One
	// still in "default" is not moved into an occupied namespace at all: see
	// TestConfigureByoCharts_RefusesAMoveIntoAnOccupiedNamespace.)
	owner := types.AddOnInstall{ID: "payments", Mode: "managed", Source: "git", ChartRepo: "https://github.com/acme/payments.git", Path: "chart", Version: "HEAD", Namespace: "byo-payments"}
	other := types.AddOnInstall{ID: explicit, Mode: "managed", Source: "git", ChartRepo: "https://github.com/acme/other.git", Path: "chart", Version: "HEAD", Namespace: "byo-payments"}
	addons := []types.AddOnInstall{owner, other}
	if explicitFirst {
		addons = []types.AddOnInstall{other, owner}
	}
	return &types.ProjectConfig{ProjectName: "Acme Corp", AddOns: addons}
}

// TestConfigureByoCharts_RefusesExactlyOneChartOfADerivedNamespaceCollision: when a chart's chosen
// namespace is another chart's derived one, the chart that CHOSE it is refused and the owner keeps it
// — whatever the ids, and whatever order the snapshot lists them in. The warning names both, and does
// not claim the refused chart can no longer sync (the namespace stays the owner's destination).
func TestConfigureByoCharts_RefusesExactlyOneChartOfADerivedNamespaceCollision(t *testing.T) {
	for _, explicit := range []string{"zeta", "alpha"} {
		for _, explicitFirst := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/explicitFirst=%v", explicit, explicitFirst), func(t *testing.T) {
				c := newByoCluster(t, "")
				_, refused, _ := byoConfigureTuple(configureByoCharts(collisionConfig(explicit, explicitFirst), "tok", nil, nil, io.Discard, io.Discard))
				if len(refused) != 1 || refused[0].ID != explicit || !refused[0].Shared {
					t.Fatalf("refused = %+v, want exactly %q (it chose payments' own name), marked shared", refused, explicit)
				}
				w := refused[0].warning()
				for _, want := range []string{`"` + explicit + `"`, `"payments"`, `"byo-payments"`, "own default namespace"} {
					if !strings.Contains(w, want) {
						t.Errorf("the warning does not say %q:\n%s", want, w)
					}
				}
				if strings.Contains(w, "can no longer sync") {
					t.Errorf("the namespace is still the owner's destination; the warning must not claim otherwise:\n%s", w)
				}
				if got := c.lastAppProjectDestinations(t, "byo-acme-corp"); !reflect.DeepEqual(got, []string{"byo-payments"}) {
					t.Errorf("AppProject destinations = %v, want [byo-payments] for the owner", got)
				}
			})
		}
	}
}

// TestByoNamespaceCollisions_FallsBackToIdOrderOnlyWithoutAnOwner: two charts that both chose a "byo-"
// name nobody here derives have no owner, so the later by id is refused — the one case id order
// decides. Two charts sharing a name outside the prefix are left alone, as they always were.
func TestByoNamespaceCollisions_FallsBackToIdOrderOnlyWithoutAnOwner(t *testing.T) {
	chart := func(id, ns string) types.AddOnInstall {
		return types.AddOnInstall{ID: id, Source: "git", Namespace: ns}
	}
	got := byoNamespaceCollisions([]types.AddOnInstall{chart("zeta", "byo-x"), chart("alpha", "byo-x"), chart("one", "shared"), chart("two", "shared")})
	if len(got) != 1 || got["zeta"] == "" {
		t.Fatalf("collisions = %v, want only zeta refused (alpha first by id; \"shared\" is not byo-)", got)
	}
	if !strings.Contains(got["zeta"], `"alpha"`) {
		t.Errorf("the reason must name the chart that keeps it: %s", got["zeta"])
	}
}

// TestConfigureByoCharts_RefusesAMoveIntoAnOccupiedNamespace: a chart in "default" whose own
// namespace is already another chart's (one that chose it before the byo- rule) is NOT moved. The
// legacy chart is refused, with a warning to attach it again with another namespace; the occupant
// deploys untouched, alone in its namespace.
func TestConfigureByoCharts_RefusesAMoveIntoAnOccupiedNamespace(t *testing.T) {
	c := newByoCluster(t, "")
	vc := &types.ProjectConfig{ProjectName: "Acme Corp", AddOns: []types.AddOnInstall{
		{ID: "payments", Mode: "managed", Source: "git", ChartRepo: "https://github.com/acme/payments.git", Path: "chart", Version: "HEAD", Namespace: "default"},
		{ID: "occupant", Mode: "managed", Source: "git", ChartRepo: "https://github.com/acme/occupant.git", Path: "chart", Version: "HEAD", Namespace: "byo-payments"},
	}}
	_, refused, moved := byoConfigureTuple(configureByoCharts(vc, "tok", nil, nil, io.Discard, io.Discard))
	if len(moved) != 0 {
		t.Errorf("moved = %+v: the move into an occupied namespace must be refused", moved)
	}
	if len(refused) != 1 || refused[0].ID != "payments" || refused[0].Shared || refused[0].Namespace != "default" {
		t.Fatalf("refused = %+v, want only the legacy chart, in default, not shared", refused)
	}
	w := refused[0].warning()
	for _, want := range []string{`"payments"`, `"byo-payments"`, `"occupant"`, `"default"`, "not moved", "Attach the chart again with a namespace of your own"} {
		if !strings.Contains(w, want) {
			t.Errorf("the warning does not say %q:\n%s", want, w)
		}
	}
	if vc.AddOns[0].Namespace != "default" {
		t.Errorf("the refused chart's namespace was rewritten to %q", vc.AddOns[0].Namespace)
	}
	if got := c.lastAppProjectDestinations(t, "byo-acme-corp"); !reflect.DeepEqual(got, []string{"byo-payments"}) {
		t.Errorf("AppProject destinations = %v, want only the occupant's byo-payments", got)
	}
}

// TestConfigureByoCharts_ReleasesTheEnvironmentsCommonLabelsOnDefault: the labels released on
// "default" include the classification labels the runner stamped with commonLabels, each only where
// the value is this environment's.
func TestConfigureByoCharts_ReleasesTheEnvironmentsCommonLabelsOnDefault(t *testing.T) {
	c := newMoveClusterWith(t, `{"items":[]}`,
		`{"metadata":{"name":"default","labels":{"alethia.io/managed-by":"byo-charts","alethia.io/environment-id":"env-1","alethia.io/project-id":"proj-1","alethia.io/team":"other"}}}`, "")
	vc := legacyByoConfig("default")
	vc.EnvironmentID = "env-1"
	common := map[string]string{"alethia.io/environment-id": "env-1", "alethia.io/project-id": "proj-1", "alethia.io/team": "payments"}
	configureByoCharts(vc, "tok", nil, common, io.Discard, io.Discard)
	want := "label namespace default alethia.io/environment-id- alethia.io/managed-by- alethia.io/project-id-"
	var labelCalls []string
	for _, line := range strings.Split(c.calls(), "\n") {
		// A server-side dry run (the Pod Security preview, #6495) changes no label.
		if strings.HasPrefix(line, "label ") && !strings.Contains(line, "--dry-run=server") {
			labelCalls = append(labelCalls, line)
		}
	}
	if !reflect.DeepEqual(labelCalls, []string{want}) {
		t.Errorf("label calls = %q, want [%q] (team carries another value and stays)", labelCalls, want)
	}
}

// TestConfigureByoCharts_KeepsTheLabelsOnDefaultWhileARefusedChartStaysThere: when one chart moves out
// of "default" but another's move is refused, the refused chart is still this environment's and still
// stored in "default", so its labels are not removed.
func TestConfigureByoCharts_KeepsTheLabelsOnDefaultWhileARefusedChartStaysThere(t *testing.T) {
	c := newMoveClusterWith(t, `{"items":[]}`,
		`{"metadata":{"name":"default","labels":{"alethia.io/managed-by":"byo-charts","alethia.io/environment-id":"env-1"}}}`, "")
	vc := &types.ProjectConfig{ProjectName: "Acme Corp", EnvironmentID: "env-1", AddOns: []types.AddOnInstall{
		{ID: "moves", Mode: "managed", Source: "git", ChartRepo: "https://github.com/acme/a.git", Path: "chart", Version: "HEAD", Namespace: "default"},
		{ID: "payments", Mode: "managed", Source: "git", ChartRepo: "https://github.com/acme/b.git", Path: "chart", Version: "HEAD", Namespace: "default"},
		{ID: "occupant", Mode: "managed", Source: "git", ChartRepo: "https://github.com/acme/c.git", Path: "chart", Version: "HEAD", Namespace: "byo-payments"},
	}}
	_, refused, moved := byoConfigureTuple(configureByoCharts(vc, "tok", nil, nil, io.Discard, io.Discard))
	if len(moved) != 1 || moved[0].ID != "moves" || len(refused) != 1 || refused[0].ID != "payments" {
		t.Fatalf("moved=%+v refused=%+v, want moves moved and payments refused", moved, refused)
	}
	if strings.Contains(c.calls(), "label namespace default") {
		t.Errorf("default's labels were removed while a refused chart of this environment is still there:\n%s", c.calls())
	}
}
