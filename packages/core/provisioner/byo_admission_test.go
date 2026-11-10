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
	var svc strings.Builder
	for ns, body := range s.Services {
		svc.WriteString("  *'get services -n " + ns + " -o json'*) cat '" + write("svc-"+ns, body) + "'; exit 0;;\n")
	}
	script := "#!/bin/sh\n" +
		"printf '%s\\n' \"$*\" >> '" + c.log + "'\n" +
		"case \"$*\" in\n" +
		"  'apply -f '*) cat \"$3\" >> '" + c.applied + "'; printf '\\n---\\n' >> '" + c.applied + "'; exit 0;;\n" +
		"  *'--ignore-not-found -o json'*) cat '" + write("ns.json", s.Namespaces) + "'; exit " + nsExit + ";;\n" +
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
		ProjectName: "Acme Corp",
		AddOns: []types.AddOnInstall{
			{ID: "old", Mode: "managed", Source: "helm", Byo: true, ChartRepo: "oci://ghcr.io/acme", Chart: "old", Version: "1.0.0", Namespace: "byo-old"},
			{ID: "fresh", Mode: "managed", Source: "helm", Byo: true, ChartRepo: "oci://ghcr.io/acme", Chart: "fresh", Version: "1.0.0", Namespace: "byo-fresh"},
		},
	}
}

// existingOld is the namespace read with byo-old present and unlabelled for admission.
const existingOld = `{"kind":"List","items":[{"kind":"Namespace","metadata":{"name":"byo-old","labels":{"alethia.io/managed-by":"byo-charts"}}}]}`

// TestConfigureByoCharts_ExistingNamespaceWarnsNewNamespaceEnforces drives the deploy step: the
// namespace that already holds a chart is applied in "warn" with no PSA enforce label, the new one
// in "enforce" with baseline, and both policies and bindings are applied.
func TestConfigureByoCharts_ExistingNamespaceWarnsNewNamespaceEnforces(t *testing.T) {
	c := newAdmissionCluster(t, admissionClusterSpec{Namespaces: existingOld, Discovery: served})
	configureByoCharts(twoChartConfig(), "tok", nil, nil, io.Discard, io.Discard)
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
	// With the policy in force, the enforce namespace is not read: the API server refuses there.
	if calls := c.calls(); strings.Contains(calls, "-n byo-fresh") {
		t.Errorf("the enforce namespace was scanned although the policy refuses there:\n%s", calls)
	}
}

// TestConfigureByoCharts_ExistingModeIsKept: a namespace someone moved to "enforce" stays there, and
// one in "warn" is not promoted by a deploy.
func TestConfigureByoCharts_ExistingModeIsKept(t *testing.T) {
	live := `{"kind":"List","items":[` +
		`{"kind":"Namespace","metadata":{"name":"byo-old","labels":{"alethia.io/byo-admission":"enforce"}}},` +
		`{"kind":"Namespace","metadata":{"name":"byo-fresh","labels":{"alethia.io/byo-admission":"warn"}}}]}`
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

// TestConfigureByoCharts_AnUnreadableClusterWarnsEverywhere: when the namespaces cannot be read, no
// namespace is put in "enforce" — not knowing whether a chart runs there is not permission to refuse.
func TestConfigureByoCharts_AnUnreadableClusterWarnsEverywhere(t *testing.T) {
	c := newAdmissionCluster(t, admissionClusterSpec{NamespacesFail: true, Discovery: served})
	var stderr bytes.Buffer
	configureByoCharts(twoChartConfig(), "tok", nil, nil, io.Discard, &stderr)
	docs := c.docs(t)
	for _, ns := range []string{"byo-old", "byo-fresh"} {
		if got := docs["Namespace/"+ns].Metadata.Labels[argocd.ByoAdmissionModeLabel]; got != "warn" {
			t.Errorf("%s mode = %q, want warn when the cluster could not be read", ns, got)
		}
	}
	if !strings.Contains(stderr.String(), "could not read the BYO namespaces") {
		t.Errorf("the unread cluster was not logged:\n%s", stderr.String())
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
	configureByoCharts(twoChartConfig(), "tok", nil, nil, io.Discard, &stderr)
	for k := range c.docs(t) {
		if strings.HasPrefix(k, "ValidatingAdmissionPolicy") {
			t.Errorf("%s was applied over a newer rule set", k)
		}
	}
	if !strings.Contains(stderr.String(), "not replacing the BYO admission policy") || !strings.Contains(stderr.String(), `"99"`) {
		t.Errorf("the newer rule set was not reported:\n%s", stderr.String())
	}
	if strings.Contains(c.calls(), "-n byo-fresh") {
		t.Error("the enforce namespace was scanned although a newer policy is in force there")
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
