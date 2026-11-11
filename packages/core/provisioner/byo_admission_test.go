// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"bytes"
	"context"
	"encoding/json"
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

// #6495: the runner decides each BYO namespace's admission mode, applies the policy where the
// cluster serves it, and reports what a namespace that does not refuse yet is running.

// admissionCluster is a scripted kubectl for these tests.
type admissionCluster struct {
	log, applied string
}

// admissionClusterSpec is what the scripted cluster answers.
type admissionClusterSpec struct {
	// Namespaces is the answer to the namespace read; NamespacesFail makes it fail.
	Namespaces     string
	NamespacesFail bool
	// Discovery is the admissionregistration.k8s.io/v1 resource list; "" serves no policy API.
	Discovery string
	// Services maps a namespace to its `get services -o json` answer.
	Services map[string]string
	// PodSecurity is what the PSA dry run prints, for every namespace.
	PodSecurity string
	// LivePolicy is the live BYO policy objects; LivePolicyFail makes that read fail.
	LivePolicy     string
	LivePolicyFail bool
	// Apps maps a chart id to its live Application's destination namespace (#6541). nil means the
	// "old" chart's Application deploys into byo-old — it is the chart that has run — and no other
	// chart has one. AppsFail makes every Application read fail.
	Apps     map[string]string
	AppsFail bool
	// ServicesFail makes the Service read of every namespace fail (#6541: a failed check).
	ServicesFail bool
	// BatchNamespacesFail makes only the several-namespace read fail (the admission decision's),
	// while each one-namespace read (#6562's) still answers.
	BatchNamespacesFail bool
}

// served is a discovery document that serves ValidatingAdmissionPolicy.
const served = `{"resources":[{"name":"validatingadmissionpolicies"},{"name":"validatingadmissionpolicybindings"}]}`

// newAdmissionCluster installs the scripted kubectl.
func newAdmissionCluster(t *testing.T, s admissionClusterSpec) *admissionCluster {
	t.Helper()
	dir := t.TempDir()
	c := &admissionCluster{log: filepath.Join(dir, "calls.log"), applied: filepath.Join(dir, "applied.yaml")}
	write := func(name, body string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}
	nsExit := "0"
	if s.NamespacesFail {
		nsExit = "1"
	}
	discExit := "0"
	if s.Discovery == "" {
		discExit = "1"
	}
	liveExit := "0"
	if s.LivePolicyFail {
		liveExit = "1"
	}
	apps := s.Apps
	if apps == nil {
		apps = map[string]string{"old": "byo-old"}
	}
	var app strings.Builder
	appExit := "0"
	if s.AppsFail {
		appExit = "1"
	}
	for id, dest := range apps {
		app.WriteString("  *'get applications.argoproj.io " + argocd.AddOnAppName(id) + " '*) printf '%s' '" + dest + "'; exit " + appExit + ";;\n")
	}
	app.WriteString("  *'get applications.argoproj.io '*) exit " + appExit + ";;\n")
	var svc strings.Builder
	if s.ServicesFail {
		svc.WriteString("  *'get services -n '*) echo 'the server is currently unable to handle the request' >&2; exit 1;;\n")
	}
	for ns, body := range s.Services {
		svc.WriteString("  *'get services -n " + ns + " -o json'*) cat '" + write("svc-"+ns, body) + "'; exit 0;;\n")
	}
	script := "#!/bin/sh\n" +
		"printf '%s\\n' \"$*\" >> '" + c.log + "'\n" +
		"case \"$*\" in\n" +
		"  'apply -f '*) cat \"$3\" >> '" + c.applied + "'; printf '\\n---\\n' >> '" + c.applied + "'; exit 0;;\n" +
		app.String() +
		batchFail(s.BatchNamespacesFail) +
		perNamespace(t, s.Namespaces, nsExit, write) +
		"  *'get namespace '*' '*' --ignore-not-found -o json'*) cat '" + write("ns.json", s.Namespaces) + "'; exit " + nsExit + ";;\n" +
		"  *'get namespace '*' --ignore-not-found -o json'*) exit " + nsExit + ";;\n" +
		"  *'get --raw /apis/admissionregistration.k8s.io/v1'*) cat '" + write("disc.json", s.Discovery) + "'; exit " + discExit + ";;\n" +
		"  *'get validatingadmissionpolicies'*) cat '" + write("live-policy.json", s.LivePolicy) + "'; exit " + liveExit + ";;\n" +
		svc.String() +
		"  *'--dry-run=server'*) cat '" + write("psa.txt", s.PodSecurity) + "'; exit 0;;\n" +
		"esac\ncat >/dev/null 2>&1\nexit 0\n"
	provStubTool(t, "kubectl", script)
	return c
}

// calls is every recorded invocation.
func (c *admissionCluster) calls() string {
	b, _ := os.ReadFile(c.log)
	return string(b)
}

// appliedDoc is the slice of an applied document these tests read.
type appliedDoc struct {
	Kind     string `yaml:"kind"`
	Metadata struct {
		Name   string            `yaml:"name"`
		Labels map[string]string `yaml:"labels"`
	} `yaml:"metadata"`
	Spec struct {
		ValidationActions []string `yaml:"validationActions"`
	} `yaml:"spec"`
}

// docs decodes every applied document, keyed by kind/name; a later apply wins.
func (c *admissionCluster) docs(t *testing.T) map[string]appliedDoc {
	t.Helper()
	out := map[string]appliedDoc{}
	raw, err := os.ReadFile(c.applied)
	if err != nil {
		return out
	}
	dec := yaml.NewDecoder(bytes.NewReader(raw))
	for {
		var d appliedDoc
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

// twoChartConfig has a chart in a namespace that exists (byo-old) and one in a new one (byo-fresh).
func twoChartConfig() *types.ProjectConfig {
	return &types.ProjectConfig{
		ProjectName:   "Acme Corp",
		EnvironmentID: "env-1",
		AddOns: []types.AddOnInstall{
			{ID: "old", Mode: "managed", Source: "helm", Byo: true, ChartRepo: "oci://ghcr.io/acme", Chart: "old", Version: "1.0.0", Namespace: "byo-old"},
			{ID: "fresh", Mode: "managed", Source: "helm", Byo: true, ChartRepo: "oci://ghcr.io/acme", Chart: "fresh", Version: "1.0.0", Namespace: "byo-fresh"},
		},
	}
}

// existingOld is the namespace read with byo-old present and unlabelled for admission.
const existingOld = `{"kind":"List","items":[{"kind":"Namespace","metadata":{"name":"byo-old","labels":{"alethia.io/managed-by":"byo-charts","alethia.io/environment-id":"env-1"}}}]}`

// TestConfigureByoCharts_ExistingNamespaceWarnsNewNamespaceEnforces drives the deploy step: the
// namespace that already holds a chart is applied in "warn" with no PSA enforce label, the new one
// in "enforce" with baseline, and both policies and bindings are applied.
func TestConfigureByoCharts_ExistingNamespaceWarnsNewNamespaceEnforces(t *testing.T) {
	c := newAdmissionCluster(t, admissionClusterSpec{Namespaces: existingOld, Discovery: served})
	got := configureByoCharts(twoChartConfig(), "tok", nil, nil, io.Discard, io.Discard)
	docs := c.docs(t)

	old, fresh := docs["Namespace/byo-old"].Metadata.Labels, docs["Namespace/byo-fresh"].Metadata.Labels
	if old[argocd.ByoAdmissionModeLabel] != "warn" || old["pod-security.kubernetes.io/enforce"] != "" {
		t.Errorf("existing namespace labels = %v, want mode warn and no PSA enforce", old)
	}
	if fresh[argocd.ByoAdmissionModeLabel] != "enforce" || fresh["pod-security.kubernetes.io/enforce"] != "baseline" {
		t.Errorf("new namespace labels = %v, want mode enforce and PSA enforce baseline", fresh)
	}
	for _, name := range argocd.ByoAdmissionPolicyNames() {
		if _, ok := docs["ValidatingAdmissionPolicy/"+name]; !ok {
			t.Errorf("policy %s was not applied", name)
		}
		if _, ok := docs["ValidatingAdmissionPolicyBinding/"+name]; !ok {
			t.Errorf("binding %s was not applied", name)
		}
	}
	// #6541: the enforce namespace is reported too — its objects read, Pod Security "enforced" — but
	// with the policy in force it is no Deploy-tab warning.
	for _, r := range got.Admission {
		if r.Namespace == "byo-fresh" && (r.warns() || !reflect.DeepEqual(r.Checks, fullChecks("enforced"))) {
			t.Errorf("the enforce namespace's report = %+v, want every kind checked, PSA enforced, no warning", r)
		}
	}
}

// TestConfigureByoCharts_ExistingModeIsKept: a namespace someone moved to "enforce" stays there, and
// one in "warn" is not promoted by a deploy.
func TestConfigureByoCharts_ExistingModeIsKept(t *testing.T) {
	live := `{"kind":"List","items":[` +
		`{"kind":"Namespace","metadata":{"name":"byo-old","labels":{"alethia.io/byo-admission":"enforce"}}},` +
		`{"kind":"Namespace","metadata":{"name":"byo-fresh","labels":{"alethia.io/byo-admission":"warn","alethia.io/managed-by":"byo-charts","alethia.io/environment-id":"env-1"}}}]}`
	c := newAdmissionCluster(t, admissionClusterSpec{Namespaces: live, Discovery: served})
	configureByoCharts(twoChartConfig(), "tok", nil, nil, io.Discard, io.Discard)
	docs := c.docs(t)
	if got := docs["Namespace/byo-old"].Metadata.Labels[argocd.ByoAdmissionModeLabel]; got != "enforce" {
		t.Errorf("byo-old mode = %q, want the enforce it already had", got)
	}
	if got := docs["Namespace/byo-fresh"].Metadata.Labels[argocd.ByoAdmissionModeLabel]; got != "warn" {
		t.Errorf("byo-fresh mode = %q, want the warn it already had", got)
	}
}

// TestConfigureByoCharts_AnUnreadableClusterAppliesNothing: when the namespaces cannot be read, no
// namespace is put in "enforce" — not knowing whether a chart runs there is not permission to refuse.
// Since #6562 the runner also cannot tell whether another environment holds the namespace, so the BYO
// stage fails closed before its first write: nothing is applied in any mode, and no chart is refused
// (a refusal would withdraw its bindings). Before #6562 this test asserted "warn" Namespaces were
// applied; that write is exactly what failing closed forbids. The admission read's own fallback to
// "warn" (byoAdmissionModes) is unchanged for a cluster the per-namespace reads could still read.
func TestConfigureByoCharts_AnUnreadableClusterAppliesNothing(t *testing.T) {
	orig := byoReadBackoff
	byoReadBackoff = 0
	t.Cleanup(func() { byoReadBackoff = orig })
	c := newAdmissionCluster(t, admissionClusterSpec{NamespacesFail: true, Discovery: served})
	got := configureByoCharts(twoChartConfig(), "tok", nil, nil, io.Discard, io.Discard)
	if got.Err == nil {
		t.Fatal("an unreadable cluster must fail the BYO stage closed")
	}
	if len(got.Refused) != 0 {
		t.Errorf("an unreadable cluster refuses no chart, got %+v", got.Refused)
	}
	if strings.Contains(c.calls(), "apply -f") {
		t.Errorf("nothing may be applied when the namespaces cannot be read:\n%s", c.calls())
	}
}

// TestConfigureByoCharts_AMovedChartsNewNamespaceWarns: a chart moved out of "default" (#6446)
// lands in a NEW namespace, but it is a running chart, so the namespace starts in "warn".
func TestConfigureByoCharts_AMovedChartsNewNamespaceWarns(t *testing.T) {
	c := newAdmissionCluster(t, admissionClusterSpec{Namespaces: "", Discovery: served})
	vc := legacyByoConfig("default")
	vc.AddOns = vc.AddOns[1:]
	configureByoCharts(vc, "tok", nil, nil, io.Discard, io.Discard)
	if got := c.docs(t)["Namespace/byo-legacy"].Metadata.Labels[argocd.ByoAdmissionModeLabel]; got != "warn" {
		t.Errorf("moved chart's namespace mode = %q, want warn", got)
	}
}

// TestConfigureByoCharts_ReportsWhatAWarnNamespaceRuns: the Deploy tab names the chart, the
// namespace, each object's kind, name and field, and PSA's own summary of the pods baseline refuses.
func TestConfigureByoCharts_ReportsWhatAWarnNamespaceRuns(t *testing.T) {
	newAdmissionCluster(t, admissionClusterSpec{
		Namespaces:  existingOld,
		Discovery:   served,
		Services:    map[string]string{"byo-old": `{"items":[{"metadata":{"name":"web"},"spec":{"type":"LoadBalancer"}},{"metadata":{"name":"api"},"spec":{"type":"ClusterIP"}}]}`},
		PodSecurity: "Warning: existing pods in namespace \"byo-old\" violate the new PodSecurity enforce level \"baseline:v1.33\"\nWarning: agent-1: hostPath volumes\n",
	})
	got := configureByoCharts(twoChartConfig(), "tok", nil, nil, io.Discard, io.Discard)
	var warned []byoAdmissionReport
	for _, r := range got.Admission {
		if r.warns() {
			warned = append(warned, r)
		}
	}
	got.Admission = warned
	if len(got.Admission) != 1 {
		t.Fatalf("admission reports = %+v, want one for byo-old", got.Admission)
	}
	w := got.Admission[0].warning()
	for _, want := range []string{`BYO chart "old"`, `namespace "byo-old"`, `Service "web": spec.type is LoadBalancer`, "Pod Security baseline: agent-1: hostPath volumes", "alethia.io/byo-admission=enforce"} {
		if !strings.Contains(w, want) {
			t.Errorf("warning does not contain %q:\n%s", want, w)
		}
	}
	if strings.Contains(w, `"api"`) {
		t.Errorf("an admitted Service was reported:\n%s", w)
	}
}

// TestConfigureByoCharts_NoPolicyAPIIsSkippedNotFailed: on a cluster without ValidatingAdmissionPolicy
// the policy is not applied, the deploy goes on, PSA still enforces in the new namespace, and the
// new namespace is checked against the rules the cluster cannot run.
func TestConfigureByoCharts_NoPolicyAPIIsSkippedNotFailed(t *testing.T) {
	c := newAdmissionCluster(t, admissionClusterSpec{
		Namespaces: existingOld,
		Services:   map[string]string{"byo-fresh": `{"items":[{"metadata":{"name":"edge"},"spec":{"type":"NodePort"}}]}`},
	})
	var stdout bytes.Buffer
	got := configureByoCharts(twoChartConfig(), "tok", nil, nil, &stdout, io.Discard)
	if !got.Configured {
		t.Fatal("the deploy step did not configure the charts")
	}
	docs := c.docs(t)
	for k := range docs {
		if strings.HasPrefix(k, "ValidatingAdmissionPolicy") {
			t.Errorf("%s was applied to a cluster that does not serve it", k)
		}
	}
	if docs["Namespace/byo-fresh"].Metadata.Labels["pod-security.kubernetes.io/enforce"] != "baseline" {
		t.Error("PSA was not enforced in the new namespace when the policy was skipped")
	}
	if !strings.Contains(stdout.String(), "Skipping the BYO admission policy") {
		t.Errorf("the skip was not logged with its reason:\n%s", stdout.String())
	}
	var fresh *byoAdmissionReport
	for i := range got.Admission {
		if got.Admission[i].Namespace == "byo-fresh" {
			fresh = &got.Admission[i]
		}
	}
	if fresh == nil || !strings.Contains(fresh.warning(), `Service "edge": spec.type is NodePort`) || !strings.Contains(fresh.warning(), "runs no admission policy") {
		t.Errorf("the enforce namespace on a cluster without the policy was not reported: %+v", got.Admission)
	}
}

// TestConfigureByoCharts_ABYOChartCannotSetItsPodSecurity: a level on a BYO chart is dropped, so it
// never renders as managedNamespaceMetadata competing with the runner's labels.
func TestConfigureByoCharts_ABYOChartCannotSetItsPodSecurity(t *testing.T) {
	newAdmissionCluster(t, admissionClusterSpec{Discovery: served})
	vc := twoChartConfig()
	vc.AddOns[0].PodSecurity = "privileged"
	configureByoCharts(vc, "tok", nil, nil, io.Discard, io.Discard)
	if vc.AddOns[0].PodSecurity != "" {
		t.Errorf("BYO chart PodSecurity = %q, want it cleared", vc.AddOns[0].PodSecurity)
	}
}

// TestRunAddOnStage_CarriesTheAdmissionReport: the add-on stage hands the report to the Deploy tab.
func TestRunAddOnStage_CarriesTheAdmissionReport(t *testing.T) {
	newAdmissionCluster(t, admissionClusterSpec{
		Namespaces: existingOld,
		Discovery:  served,
		Services:   map[string]string{"byo-old": `{"items":[{"metadata":{"name":"web"},"spec":{"type":"LoadBalancer"}}]}`},
	})
	vc := twoChartConfig()
	vc.AddOns = vc.AddOns[:1]
	stage, err := runAddOnStage(context.Background(), addOnStageInput{
		VC:             vc,
		Facts:          &argocd.InfraFacts{},
		Provider:       "aws",
		GitAccessToken: "tok",
		Refresh:        func(context.Context, string) error { return nil },
	}, io.Discard, io.Discard)
	if err != nil {
		t.Fatalf("runAddOnStage: %v", err)
	}
	found := false
	for _, w := range stage.Warnings {
		if strings.Contains(w, `Service "web": spec.type is LoadBalancer`) {
			found = true
		}
	}
	if !found {
		t.Errorf("the admission report did not reach the Deploy tab: %v", stage.Warnings)
	}
}

// newerLivePolicy is a live policy applied by a runner with a newer rule set.
const newerLivePolicy = `{"kind":"List","items":[{"kind":"ValidatingAdmissionPolicy","metadata":{"name":"alethia-byo-admission-enforce","annotations":{"alethia.io/byo-admission-schema":"99"}}}]}`

// TestConfigureByoCharts_ANewerLivePolicyIsNotReplaced: an older runner leaves a newer rule set in
// place and says so, and treats it as in force (the enforce namespace is not scanned).
func TestConfigureByoCharts_ANewerLivePolicyIsNotReplaced(t *testing.T) {
	c := newAdmissionCluster(t, admissionClusterSpec{Namespaces: existingOld, Discovery: served, LivePolicy: newerLivePolicy})
	var stderr bytes.Buffer
	got := configureByoCharts(twoChartConfig(), "tok", nil, nil, io.Discard, &stderr)
	for k := range c.docs(t) {
		if strings.HasPrefix(k, "ValidatingAdmissionPolicy") {
			t.Errorf("%s was applied over a newer rule set", k)
		}
	}
	if !strings.Contains(stderr.String(), "not replacing the BYO admission policy") || !strings.Contains(stderr.String(), `"99"`) {
		t.Errorf("the newer rule set was not reported:\n%s", stderr.String())
	}
	for _, r := range got.Admission {
		if r.Namespace == "byo-fresh" && r.warns() {
			t.Errorf("the enforce namespace was warned about although a newer policy is in force there: %+v", r)
		}
	}
}

// TestConfigureByoCharts_AnUnreadableLivePolicyIsNotOverwritten: when the live policy cannot be read
// the runner does not apply blind, and reports the enforce namespace as having no policy it knows of.
func TestConfigureByoCharts_AnUnreadableLivePolicyIsNotOverwritten(t *testing.T) {
	c := newAdmissionCluster(t, admissionClusterSpec{
		Namespaces: existingOld, Discovery: served, LivePolicyFail: true,
		Services: map[string]string{"byo-fresh": `{"items":[{"metadata":{"name":"edge"},"spec":{"type":"NodePort"}}]}`},
	})
	got := configureByoCharts(twoChartConfig(), "tok", nil, nil, io.Discard, io.Discard)
	for k := range c.docs(t) {
		if strings.HasPrefix(k, "ValidatingAdmissionPolicy") {
			t.Errorf("%s was applied although the live policy could not be read", k)
		}
	}
	reported := false
	for _, r := range got.Admission {
		if r.Namespace == "byo-fresh" && strings.Contains(r.warning(), "could not be read") {
			reported = true
		}
	}
	if !reported {
		t.Errorf("the enforce namespace was not reported: %+v", got.Admission)
	}
}

// ---- #6541: the mode follows the chart's history, and the environment's setting ----

// historyConfig is twoChartConfig for environment "env-1", with the console's history: "old" has
// run in this environment, "fresh" has not.
func historyConfig(enforce bool) *types.ProjectConfig {
	vc := twoChartConfig()
	vc.EnvironmentID = "env-1"
	vc.ByoAdmission = &types.ByoAdmissionConfig{Enforce: enforce, DeployedCharts: []string{"old"}}
	return vc
}

// nsList is a namespace read answering with the given namespaces and their labels (JSON objects).
func nsList(items map[string]string) string {
	var parts []string
	for name, labels := range items {
		parts = append(parts, `{"kind":"Namespace","metadata":{"name":"`+name+`","labels":`+labels+`}}`)
	}
	return `{"kind":"List","items":[` + strings.Join(parts, ",") + `]}`
}

// TestConfigureByoCharts_AChartThatRanGetsWarnInANamespaceNewToTheCluster: (a) a chart that ran
// before lands in a namespace the cluster does not have — its namespace was changed in the console,
// the cluster re-provisioned, the namespace recreated — and gets warn; before #6541 it got enforce
// and its next deploy failed. The new chart in a new namespace still gets enforce.
func TestConfigureByoCharts_AChartThatRanGetsWarnInANamespaceNewToTheCluster(t *testing.T) {
	c := newAdmissionCluster(t, admissionClusterSpec{Namespaces: "", Discovery: served})
	got := configureByoCharts(historyConfig(false), "tok", nil, nil, io.Discard, io.Discard)
	docs := c.docs(t)
	if m := docs["Namespace/byo-old"].Metadata.Labels[argocd.ByoAdmissionModeLabel]; m != "warn" {
		t.Errorf("byo-old mode = %q, want warn for a chart that has run", m)
	}
	if m := docs["Namespace/byo-fresh"].Metadata.Labels[argocd.ByoAdmissionModeLabel]; m != "enforce" {
		t.Errorf("byo-fresh mode = %q, want enforce for a chart that never ran", m)
	}
	if len(got.Refused) != 0 {
		t.Errorf("refused = %+v, want none", got.Refused)
	}
}

// TestConfigureByoCharts_ANewChartIsRefusedANamespaceThatIsNotThisEnvironments: (a) a newly attached
// chart targets a namespace that exists and is not a BYO namespace of this environment. It is
// refused — not deployed, not a project destination, its namespace not relabelled — and the chart
// that ran keeps deploying.
func TestConfigureByoCharts_ANewChartIsRefusedANamespaceThatIsNotThisEnvironments(t *testing.T) {
	c := newAdmissionCluster(t, admissionClusterSpec{
		Namespaces: nsList(map[string]string{"byo-fresh": `{"team":"payments"}`}),
		Discovery:  served,
	})
	got := configureByoCharts(historyConfig(false), "tok", nil, nil, io.Discard, io.Discard)
	if len(got.Refused) != 1 || got.Refused[0].ID != "fresh" || !strings.Contains(got.Refused[0].Reason, "is not a bring-your-own namespace of this environment") {
		t.Fatalf("refused = %+v, want only fresh, as not this environment's namespace", got.Refused)
	}
	docs := c.docs(t)
	if _, ok := docs["Namespace/byo-fresh"]; ok {
		t.Error("the refused chart's namespace was relabelled")
	}
	if docs["AppProject/byo-acme-corp"].Kind == "" {
		t.Fatalf("the AppProject was not applied: %v", docs)
	}
	raw, _ := os.ReadFile(c.applied)
	if strings.Contains(string(raw), "namespace: byo-fresh") {
		t.Errorf("the refused namespace is still a project destination:\n%s", raw)
	}
	if m := docs["Namespace/byo-old"].Metadata.Labels[argocd.ByoAdmissionModeLabel]; m != "warn" {
		t.Errorf("byo-old mode = %q, want warn", m)
	}
	var status *argocd.ByoAdmissionNamespaceStatus
	for i := range got.AdmissionStatus {
		if got.AdmissionStatus[i].Namespace == "byo-fresh" {
			status = &got.AdmissionStatus[i]
		}
	}
	if status == nil || status.Mode != "refused" || !reflect.DeepEqual(status.Charts, []string{"fresh"}) {
		t.Errorf("the Deploy tab status for the refused namespace = %+v", status)
	}
}

// TestConfigureByoCharts_ANewChartInThisEnvironmentsOwnNamespaceWarns: a namespace that is already
// this environment's (managed-by and its owner label) may hold a detached chart's objects, so a new
// chart there starts it in warn rather than being refused.
func TestConfigureByoCharts_ANewChartInThisEnvironmentsOwnNamespaceWarns(t *testing.T) {
	c := newAdmissionCluster(t, admissionClusterSpec{
		Namespaces: nsList(map[string]string{"byo-fresh": `{"alethia.io/managed-by":"byo-charts","alethia.io/environment-id":"env-1"}`}),
		Discovery:  served,
	})
	got := configureByoCharts(historyConfig(false), "tok", nil, nil, io.Discard, io.Discard)
	if len(got.Refused) != 0 {
		t.Fatalf("refused = %+v, want none", got.Refused)
	}
	if m := c.docs(t)["Namespace/byo-fresh"].Metadata.Labels[argocd.ByoAdmissionModeLabel]; m != "warn" {
		t.Errorf("byo-fresh mode = %q, want warn", m)
	}
}

// TestConfigureByoCharts_TheSettingMovesWarnToEnforce: with the environment's setting on, a warn
// namespace is relabelled enforce, marked as the setting's, and the Deploy tab is told of the change.
func TestConfigureByoCharts_TheSettingMovesWarnToEnforce(t *testing.T) {
	c := newAdmissionCluster(t, admissionClusterSpec{
		Namespaces: nsList(map[string]string{"byo-old": `{"alethia.io/managed-by":"byo-charts","alethia.io/byo-admission":"warn"}`}),
		Discovery:  served,
	})
	got := configureByoCharts(historyConfig(true), "tok", nil, nil, io.Discard, io.Discard)
	labels := c.docs(t)["Namespace/byo-old"].Metadata.Labels
	if labels[argocd.ByoAdmissionModeLabel] != "enforce" || labels[argocd.ByoAdmissionSourceLabel] != "environment-setting" || labels["pod-security.kubernetes.io/enforce"] != "baseline" {
		t.Errorf("byo-old labels = %v, want enforce by the setting, with PSA baseline", labels)
	}
	if len(got.AdmissionChanges) != 1 || got.AdmissionChanges[0] != (byoAdmissionChange{Namespace: "byo-old", From: "warn", To: "enforce"}) {
		t.Fatalf("changes = %+v, want byo-old warn → enforce", got.AdmissionChanges)
	}
	if w := got.AdmissionChanges[0].warning(); !strings.Contains(w, `"byo-old"`) || !strings.Contains(w, "warn → enforce") || !strings.Contains(w, "setting") {
		t.Errorf("change warning = %s", w)
	}
}

// TestConfigureByoCharts_TurningTheSettingOffReturnsItsNamespacesToWarn: a namespace the setting put
// in enforce returns to warn once it is off, and is told; one in enforce on its own stays.
func TestConfigureByoCharts_TurningTheSettingOffReturnsItsNamespacesToWarn(t *testing.T) {
	c := newAdmissionCluster(t, admissionClusterSpec{
		Namespaces: nsList(map[string]string{
			"byo-old":   `{"alethia.io/byo-admission":"enforce","alethia.io/byo-admission-source":"environment-setting"}`,
			"byo-fresh": `{"alethia.io/byo-admission":"enforce","alethia.io/managed-by":"byo-charts","alethia.io/environment-id":"env-1"}`,
		}),
		Discovery: served,
	})
	got := configureByoCharts(historyConfig(false), "tok", nil, nil, io.Discard, io.Discard)
	docs := c.docs(t)
	old := docs["Namespace/byo-old"].Metadata.Labels
	if old[argocd.ByoAdmissionModeLabel] != "warn" || old[argocd.ByoAdmissionSourceLabel] != "" {
		t.Errorf("byo-old labels = %v, want warn, unmarked", old)
	}
	if m := docs["Namespace/byo-fresh"].Metadata.Labels[argocd.ByoAdmissionModeLabel]; m != "enforce" {
		t.Errorf("byo-fresh mode = %q, want the enforce it had on its own", m)
	}
	if len(got.AdmissionChanges) != 1 || got.AdmissionChanges[0].To != "warn" || !strings.Contains(got.AdmissionChanges[0].warning(), "is off") {
		t.Errorf("changes = %+v, want byo-old enforce → warn", got.AdmissionChanges)
	}
}

// TestConfigureByoCharts_AnUnreadClusterFailsTheDeploy (#6541, consistent with #6562): with history
// and the setting, a namespace read that fails fails the BYO stage before its first write — no chart is
// refused (a refusal withdraws its bindings) and no admission label is rendered.
func TestConfigureByoCharts_AnUnreadClusterFailsTheDeploy(t *testing.T) {
	noBackoff(t)
	c := newAdmissionCluster(t, admissionClusterSpec{NamespacesFail: true, Discovery: served})
	got := configureByoCharts(historyConfig(true), "tok", nil, nil, io.Discard, io.Discard)
	if got.Err == nil || len(got.Refused) != 0 {
		t.Fatalf("err=%v refused=%+v; want the stage failed and nothing refused", got.Err, got.Refused)
	}
	if strings.Contains(c.calls(), "apply -f") {
		t.Errorf("nothing may be applied on an unread cluster:\n%s", c.calls())
	}
}

// TestConfigureByoCharts_AnUnreadApplicationFailsTheDeploy: the same for a chart's Application read,
// which is what tells whether it already runs in its namespace.
func TestConfigureByoCharts_AnUnreadApplicationFailsTheDeploy(t *testing.T) {
	noBackoff(t)
	c := newAdmissionCluster(t, admissionClusterSpec{Namespaces: existingOld, Discovery: served, AppsFail: true})
	got := configureByoCharts(historyConfig(false), "tok", nil, nil, io.Discard, io.Discard)
	if got.Err == nil || !strings.Contains(got.Err.Error(), "Application") || len(got.Refused) != 0 {
		t.Fatalf("err=%v refused=%+v; want the stage failed on the Application read", got.Err, got.Refused)
	}
	if strings.Contains(c.calls(), "apply -f") {
		t.Errorf("nothing may be applied when an Application cannot be read:\n%s", c.calls())
	}
}

// TestConfigureByoCharts_TheOffSwitchSurvivesAnUnreadDeploy is the review's sequence: the setting
// on, a namespace it moved, one deploy on an unreadable cluster, then the setting off. The unread
// deploy writes nothing, so the source label survives, and the next deploy returns it to warn.
func TestConfigureByoCharts_TheOffSwitchSurvivesAnUnreadDeploy(t *testing.T) {
	noBackoff(t)
	moved := nsList(map[string]string{"byo-old": `{"alethia.io/managed-by":"byo-charts","alethia.io/environment-id":"env-1","alethia.io/byo-admission":"enforce","alethia.io/byo-admission-source":"environment-setting"}`})
	unread := newAdmissionCluster(t, admissionClusterSpec{NamespacesFail: true, Discovery: served})
	if got := configureByoCharts(historyConfig(true), "tok", nil, nil, io.Discard, io.Discard); got.Err == nil {
		t.Fatal("the unread deploy must fail")
	}
	if strings.Contains(unread.calls(), "apply -f") {
		t.Fatal("the unread deploy rewrote a namespace, so the source label may be gone")
	}
	after := newAdmissionCluster(t, admissionClusterSpec{Namespaces: moved, Discovery: served})
	configureByoCharts(historyConfig(false), "tok", nil, nil, io.Discard, io.Discard)
	if m := after.docs(t)["Namespace/byo-old"].Metadata.Labels[argocd.ByoAdmissionModeLabel]; m != "warn" {
		t.Errorf("byo-old mode after the setting is turned off = %q, want warn", m)
	}
}

// TestConfigureByoCharts_ADriftRecordDoesNotLiftTheRefusal is the review's bypass: the console's
// record says a chart has run (a drift scan read its name), but no Application of it deploys into the
// foreign namespace it asks for. It stays refused.
func TestConfigureByoCharts_ADriftRecordDoesNotLiftTheRefusal(t *testing.T) {
	newAdmissionCluster(t, admissionClusterSpec{
		Namespaces: nsList(map[string]string{"byo-fresh": `{"team":"payments"}`}),
		Discovery:  served,
	})
	vc := historyConfig(false)
	vc.ByoAdmission.DeployedCharts = []string{"old", "fresh"}
	got := configureByoCharts(vc, "tok", nil, nil, io.Discard, io.Discard)
	if len(got.Refused) != 1 || got.Refused[0].ID != "fresh" {
		t.Fatalf("refused = %+v, want fresh refused although the console lists it as run", got.Refused)
	}
}

// TestConfigureByoCharts_AChartThatRunsElsewhereMayNotMoveIntoAForeignNamespace: an Application
// deploying into another namespace is history for choosing a mode, but not for taking over a namespace
// that is someone else's (attach in your own namespace, then change it to theirs).
func TestConfigureByoCharts_AChartThatRunsElsewhereMayNotMoveIntoAForeignNamespace(t *testing.T) {
	newAdmissionCluster(t, admissionClusterSpec{
		Namespaces: nsList(map[string]string{"byo-fresh": `{"team":"payments"}`}),
		Discovery:  served,
		Apps:       map[string]string{"old": "byo-old", "fresh": "byo-own"},
	})
	got := configureByoCharts(historyConfig(false), "tok", nil, nil, io.Discard, io.Discard)
	if len(got.Refused) != 1 || got.Refused[0].ID != "fresh" {
		t.Fatalf("refused = %+v, want fresh refused", got.Refused)
	}
}

// TestConfigureByoCharts_AFailedCheckIsRecordedNotReadAsClean: a kind that cannot be read is a
// "failed" check on the namespace's status, never an empty finding list that reads as clean.
func TestConfigureByoCharts_AFailedCheckIsRecordedNotReadAsClean(t *testing.T) {
	newAdmissionCluster(t, admissionClusterSpec{Namespaces: existingOld, Discovery: served, ServicesFail: true})
	got := configureByoCharts(historyConfig(false), "tok", nil, nil, io.Discard, io.Discard)
	for _, st := range got.AdmissionStatus {
		if st.Namespace != "byo-old" {
			continue
		}
		want := fullChecks("checked")
		want[0].State = "failed"
		if !reflect.DeepEqual(st.Checks, want) {
			t.Errorf("byo-old checks = %+v, want Service failed and the rest checked", st.Checks)
		}
		return
	}
	t.Fatalf("no status for byo-old: %+v", got.AdmissionStatus)
}

// noBackoff makes the read retries immediate for the test.
func noBackoff(t *testing.T) {
	t.Helper()
	orig := byoReadBackoff
	byoReadBackoff = 0
	t.Cleanup(func() { byoReadBackoff = orig })
}

// fullChecks is every kind checked, with Pod Security in psa.
func fullChecks(psa string) []argocd.ByoAdmissionCheck {
	return []argocd.ByoAdmissionCheck{{Kind: "Service", State: "checked"}, {Kind: "Ingress", State: "checked"}, {Kind: "Secret", State: "checked"}, {Kind: "PodSecurity", State: psa}}
}

// TestConfigureByoCharts_AMovedChartIsHistory: a chart moved out of "default" (#6446) has run, even
// when the console has not read its Application back, so its new namespace gets warn.
func TestConfigureByoCharts_AMovedChartIsHistory(t *testing.T) {
	c := newAdmissionCluster(t, admissionClusterSpec{Namespaces: "", Discovery: served})
	vc := legacyByoConfig("default")
	vc.AddOns = vc.AddOns[1:]
	vc.EnvironmentID = "env-1"
	vc.ByoAdmission = &types.ByoAdmissionConfig{DeployedCharts: []string{}}
	got := configureByoCharts(vc, "tok", nil, nil, io.Discard, io.Discard)
	if m := c.docs(t)["Namespace/byo-legacy"].Metadata.Labels[argocd.ByoAdmissionModeLabel]; m != "warn" || len(got.Refused) != 0 {
		t.Errorf("moved chart's namespace mode = %q, refused %+v; want warn and none", m, got.Refused)
	}
}

// TestRunAddOnStage_CarriesTheAdmissionStatusAndChanges: the stage hands each namespace's status to
// GitopsStatus and the setting's change to the Deploy tab's warnings, and leaves the refused chart
// out of what it deploys.
func TestRunAddOnStage_CarriesTheAdmissionStatusAndChanges(t *testing.T) {
	newAdmissionCluster(t, admissionClusterSpec{
		Namespaces: nsList(map[string]string{
			"byo-old":   `{"alethia.io/byo-admission":"warn"}`,
			"byo-fresh": `{"team":"payments"}`,
		}),
		Discovery: served,
	})
	stage, err := runAddOnStage(context.Background(), addOnStageInput{
		VC:             historyConfig(true),
		Facts:          &argocd.InfraFacts{},
		Provider:       "aws",
		GitAccessToken: "tok",
		Refresh:        func(context.Context, string) error { return nil },
	}, io.Discard, io.Discard)
	if err != nil {
		t.Fatalf("runAddOnStage: %v", err)
	}
	want := []argocd.ByoAdmissionNamespaceStatus{
		{Namespace: "byo-fresh", Charts: []string{"fresh"}, Mode: "refused", Reason: "not-this-environments-namespace"},
		{Namespace: "byo-old", Charts: []string{"old"}, Mode: "enforce", Previous: "warn", Reason: "environment-setting", Checks: fullChecks("enforced")},
	}
	if !reflect.DeepEqual(stage.ByoAdmission, want) {
		t.Errorf("status = %+v\nwant     %+v", stage.ByoAdmission, want)
	}
	changed := false
	for _, w := range stage.Warnings {
		if strings.Contains(w, "warn → enforce") {
			changed = true
		}
	}
	if !changed {
		t.Errorf("the setting's change did not reach the Deploy tab: %v", stage.Warnings)
	}
	for _, a := range stage.Deployable {
		if a.ID == "fresh" {
			t.Error("the refused chart is deployable")
		}
	}
}

// batchFail is the script line that fails a several-namespace read, or nothing.
func batchFail(on bool) string {
	if !on {
		return ""
	}
	return "  *'get namespace '*' '*' --ignore-not-found -o json'*) echo 'etcdserver: request timed out' >&2; exit 1;;\n"
}

// TestConfigureByoCharts_TheAdmissionReadFailingAloneFailsTheDeploy: the decision's own namespace
// read failing fails the stage, even when #6562's one-namespace reads answer.
func TestConfigureByoCharts_TheAdmissionReadFailingAloneFailsTheDeploy(t *testing.T) {
	noBackoff(t)
	c := newAdmissionCluster(t, admissionClusterSpec{Namespaces: existingOld, Discovery: served, BatchNamespacesFail: true})
	got := configureByoCharts(historyConfig(true), "tok", nil, nil, io.Discard, io.Discard)
	if got.Err == nil || !strings.Contains(got.Err.Error(), "admission mode") || len(got.Refused) != 0 {
		t.Fatalf("err=%v refused=%+v; want the stage failed on the admission read", got.Err, got.Refused)
	}
	if strings.Contains(c.calls(), "apply -f") {
		t.Errorf("nothing may be applied:\n%s", c.calls())
	}
}

// TestConfigureByoCharts_AnApplicationElsewhereIsHistoryForANewNamespace: a chart whose Application
// deploys into another namespace has run, so the NEW namespace it moves to starts in warn — its next
// deploy must not fail under refusal — even with no console record.
func TestConfigureByoCharts_AnApplicationElsewhereIsHistoryForANewNamespace(t *testing.T) {
	c := newAdmissionCluster(t, admissionClusterSpec{
		Namespaces: existingOld, Discovery: served,
		Apps: map[string]string{"old": "byo-old", "fresh": "byo-previous"},
	})
	vc := historyConfig(false)
	vc.ByoAdmission.DeployedCharts = []string{}
	configureByoCharts(vc, "tok", nil, nil, io.Discard, io.Discard)
	if m := c.docs(t)["Namespace/byo-fresh"].Metadata.Labels[argocd.ByoAdmissionModeLabel]; m != "warn" {
		t.Errorf("byo-fresh mode = %q, want warn for a chart whose Application runs elsewhere", m)
	}
}

// TestConfigureByoCharts_TheSettingNeverRelabelsAHeldNamespace (#6562 kept): a chart that already runs
// in a namespace another environment holds keeps deploying there, and with the setting on that
// namespace is neither rendered nor decided — this environment never relabels it to enforce.
func TestConfigureByoCharts_TheSettingNeverRelabelsAHeldNamespace(t *testing.T) {
	held := nsList(map[string]string{
		"byo-old":   `{"alethia.io/environment-id":"env-2","alethia.io/byo-admission":"warn"}`,
		"byo-fresh": `{"alethia.io/managed-by":"byo-charts","alethia.io/environment-id":"env-1"}`,
	})
	c := newAdmissionCluster(t, admissionClusterSpec{Namespaces: held, Discovery: served, Apps: map[string]string{"old": "byo-old"}})
	got := configureByoCharts(historyConfig(true), "tok", nil, nil, io.Discard, io.Discard)
	if got.Err != nil || len(got.Refused) != 0 {
		t.Fatalf("err=%v refused=%+v; want the running chart kept", got.Err, got.Refused)
	}
	if _, ok := c.docs(t)["Namespace/byo-old"]; ok {
		t.Error("the held namespace was rendered")
	}
	for _, st := range got.AdmissionStatus {
		if st.Namespace == "byo-old" {
			t.Errorf("the held namespace was decided: %+v", st)
		}
	}
	for _, ch := range got.AdmissionChanges {
		if ch.Namespace == "byo-old" {
			t.Errorf("the setting changed the held namespace: %+v", ch)
		}
	}
}

// TestConfigureByoCharts_AnEnforceNamespaceUnderThePolicyIsRecordedNotWarned: what an enforce
// namespace already runs is in its status — the consent report — but is no Deploy-tab warning while
// the policy is in force: the API server refuses its next change.
func TestConfigureByoCharts_AnEnforceNamespaceUnderThePolicyIsRecordedNotWarned(t *testing.T) {
	newAdmissionCluster(t, admissionClusterSpec{
		Namespaces: existingOld, Discovery: served,
		Services: map[string]string{"byo-fresh": `{"items":[{"metadata":{"name":"edge"},"spec":{"type":"NodePort"}}]}`},
	})
	got := configureByoCharts(historyConfig(false), "tok", nil, nil, io.Discard, io.Discard)
	found := false
	for _, st := range got.AdmissionStatus {
		if st.Namespace == "byo-fresh" && st.Mode == "enforce" && len(st.Findings) == 1 {
			found = true
		}
	}
	if !found {
		t.Errorf("the enforce namespace's finding is not in its status: %+v", got.AdmissionStatus)
	}
	for _, r := range got.Admission {
		if r.Namespace == "byo-fresh" && r.warns() {
			t.Errorf("an enforce namespace under the policy warned: %+v", r)
		}
	}
}

// perNamespace answers a one-namespace read (#6562's readNamespaceLabels) with that namespace's own
// object out of the List the spec gives, as kubectl does; a namespace not in the List reads as absent.
func perNamespace(t *testing.T, list, exit string, write func(name, body string) string) string {
	t.Helper()
	if strings.TrimSpace(list) == "" {
		return ""
	}
	var doc struct {
		Items []json.RawMessage `json:"items"`
	}
	if err := json.Unmarshal([]byte(list), &doc); err != nil {
		t.Fatalf("the namespace answer is not a List: %v", err)
	}
	var b strings.Builder
	for _, raw := range doc.Items {
		var item struct {
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
		}
		if err := json.Unmarshal(raw, &item); err != nil {
			t.Fatal(err)
		}
		b.WriteString("  *'get namespace " + item.Metadata.Name + " --ignore-not-found -o json'*) cat '" + write("ns-"+item.Metadata.Name+".json", string(raw)) + "'; exit " + exit + ";;\n")
	}
	return b.String()
}
