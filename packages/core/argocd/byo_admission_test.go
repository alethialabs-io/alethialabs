// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"bytes"
	"errors"
	"io"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// #6495: Pod Security Admission labels and a ValidatingAdmissionPolicy for BYO namespaces, rolled
// out so that a chart already running is reported to and never refused by a deploy.

// renderedNamespaceLabels renders namespaces with modes and returns each namespace's labels.
func renderedNamespaceLabels(t *testing.T, namespaces []string, common map[string]string, modes map[string]ByoAdmissionMode) map[string]map[string]string {
	t.Helper()
	out, err := RenderByoNamespaces(namespaces, common, modes)
	if err != nil {
		t.Fatalf("render namespaces: %v", err)
	}
	got := map[string]map[string]string{}
	dec := yaml.NewDecoder(strings.NewReader(out))
	for {
		var d struct {
			Metadata struct {
				Name   string            `yaml:"name"`
				Labels map[string]string `yaml:"labels"`
			} `yaml:"metadata"`
		}
		if err := dec.Decode(&d); err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			t.Fatalf("parse namespaces: %v\n%s", err, out)
		}
		got[d.Metadata.Name] = d.Metadata.Labels
	}
	return got
}

// TestByoNamespaces_PodSecurityFollowsTheMode: an "enforce" namespace enforces baseline and reports
// restricted, a "warn" namespace only reports restricted, every level is pinned to v1.33, and the
// mode label is on both.
func TestByoNamespaces_PodSecurityFollowsTheMode(t *testing.T) {
	got := renderedNamespaceLabels(t, []string{"byo-new", "byo-old"}, nil,
		map[string]ByoAdmissionMode{"byo-new": ByoAdmissionEnforce, "byo-old": ByoAdmissionWarn})

	report := map[string]string{
		"pod-security.kubernetes.io/warn":          "restricted",
		"pod-security.kubernetes.io/warn-version":  "v1.33",
		"pod-security.kubernetes.io/audit":         "restricted",
		"pod-security.kubernetes.io/audit-version": "v1.33",
	}
	for ns, mode := range map[string]string{"byo-new": "enforce", "byo-old": "warn"} {
		labels := got[ns]
		if labels[ByoAdmissionModeLabel] != mode {
			t.Errorf("%s: %s = %q, want %q", ns, ByoAdmissionModeLabel, labels[ByoAdmissionModeLabel], mode)
		}
		for k, v := range report {
			if labels[k] != v {
				t.Errorf("%s: %s = %q, want %q", ns, k, labels[k], v)
			}
		}
		if labels["alethia.io/managed-by"] != "byo-charts" {
			t.Errorf("%s lost its managed-by label: %v", ns, labels)
		}
	}
	if got["byo-new"]["pod-security.kubernetes.io/enforce"] != "baseline" || got["byo-new"]["pod-security.kubernetes.io/enforce-version"] != "v1.33" {
		t.Errorf("an enforce namespace must enforce baseline at v1.33: %v", got["byo-new"])
	}
	for _, k := range []string{"pod-security.kubernetes.io/enforce", "pod-security.kubernetes.io/enforce-version"} {
		if _, ok := got["byo-old"][k]; ok {
			t.Errorf("a warn namespace carries %s: an existing chart's next pod could be refused (%v)", k, got["byo-old"])
		}
	}
}

// TestByoNamespaces_AnUndecidedModeIsWarn: a namespace the caller did not decide — missing from the
// map, or carrying a value no binding selects — is rendered in "warn", and a caller's label cannot
// set the mode or the PSA level.
func TestByoNamespaces_AnUndecidedModeIsWarn(t *testing.T) {
	common := map[string]string{
		ByoAdmissionModeLabel:                "enforce",
		"pod-security.kubernetes.io/enforce": "baseline",
		"pod-security.kubernetes.io/warn":    "privileged",
		"alethia.io/project-id":              "p-1",
	}
	got := renderedNamespaceLabels(t, []string{"byo-missing", "byo-bogus"}, common,
		map[string]ByoAdmissionMode{"byo-bogus": "deny"})
	for _, ns := range []string{"byo-missing", "byo-bogus"} {
		labels := got[ns]
		if labels[ByoAdmissionModeLabel] != "warn" {
			t.Errorf("%s: mode = %q, want warn", ns, labels[ByoAdmissionModeLabel])
		}
		if _, ok := labels["pod-security.kubernetes.io/enforce"]; ok {
			t.Errorf("%s: a caller's label set the PSA enforce level: %v", ns, labels)
		}
		if labels["pod-security.kubernetes.io/warn"] != "restricted" {
			t.Errorf("%s: a caller's label changed the PSA warn level: %v", ns, labels)
		}
		if labels["alethia.io/project-id"] != "p-1" {
			t.Errorf("%s lost a common label: %v", ns, labels)
		}
	}
}

// TestDecideByoAdmissionModes: new → enforce; existing → warn; a chart moved in → warn; an existing
// mode is kept in both directions; a value that is not a mode is not kept.
func TestDecideByoAdmissionModes(t *testing.T) {
	live := map[string]map[string]string{
		"existing-bare":    nil,
		"existing-labels":  {"team": "x"},
		"existing-enforce": {ByoAdmissionModeLabel: "enforce"},
		"existing-warn":    {ByoAdmissionModeLabel: "warn"},
		"existing-garbage": {ByoAdmissionModeLabel: "Deny"},
		"moved-existing":   {ByoAdmissionModeLabel: "enforce"},
	}
	inherited := map[string]bool{"moved-new": true, "moved-existing": true}
	ns := []string{"new", "existing-bare", "existing-labels", "existing-enforce", "existing-warn", "existing-garbage", "moved-new", "moved-existing"}
	got := DecideByoAdmissionModes(ns, live, inherited)
	want := map[string]ByoAdmissionMode{
		"new":              ByoAdmissionEnforce,
		"existing-bare":    ByoAdmissionWarn,
		"existing-labels":  ByoAdmissionWarn,
		"existing-enforce": ByoAdmissionEnforce,
		"existing-warn":    ByoAdmissionWarn,
		"existing-garbage": ByoAdmissionWarn,
		"moved-new":        ByoAdmissionWarn,
		"moved-existing":   ByoAdmissionEnforce,
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("modes = %v\nwant    %v", got, want)
	}
}

// renderedPolicy is the slice of the rendered policy documents these tests read.
type renderedPolicy struct {
	Kind     string `yaml:"kind"`
	Metadata struct {
		Name   string            `yaml:"name"`
		Labels map[string]string `yaml:"labels"`
	} `yaml:"metadata"`
	Spec struct {
		FailurePolicy    string `yaml:"failurePolicy"`
		MatchConstraints struct {
			ResourceRules []struct {
				APIGroups   []string `yaml:"apiGroups"`
				APIVersions []string `yaml:"apiVersions"`
				Operations  []string `yaml:"operations"`
				Resources   []string `yaml:"resources"`
			} `yaml:"resourceRules"`
		} `yaml:"matchConstraints"`
		Validations []struct {
			Expression string `yaml:"expression"`
			Message    string `yaml:"message"`
			Reason     string `yaml:"reason"`
		} `yaml:"validations"`
		PolicyName        string   `yaml:"policyName"`
		ValidationActions []string `yaml:"validationActions"`
		MatchResources    struct {
			NamespaceSelector struct {
				MatchLabels map[string]string `yaml:"matchLabels"`
			} `yaml:"namespaceSelector"`
		} `yaml:"matchResources"`
	} `yaml:"spec"`
}

// renderPolicyDocs renders the policy and decodes every document.
func renderPolicyDocs(t *testing.T) []renderedPolicy {
	t.Helper()
	out, err := RenderByoAdmissionPolicy()
	if err != nil {
		t.Fatalf("render policy: %v", err)
	}
	var docs []renderedPolicy
	dec := yaml.NewDecoder(bytes.NewReader([]byte(out)))
	for {
		var d renderedPolicy
		if err := dec.Decode(&d); err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			t.Fatalf("parse policy: %v\n%s", err, out)
		}
		docs = append(docs, d)
	}
	return docs
}

// selects reports whether a binding's namespaceSelector (matchLabels only) selects labels.
func selects(b renderedPolicy, labels map[string]string) bool {
	sel := b.Spec.MatchResources.NamespaceSelector.MatchLabels
	if len(sel) == 0 {
		return true
	}
	for k, v := range sel {
		if labels[k] != v {
			return false
		}
	}
	return true
}

// bindingsSelecting returns the validationActions of every binding that selects labels.
func bindingsSelecting(docs []renderedPolicy, labels map[string]string) [][]string {
	var out [][]string
	for _, d := range docs {
		if d.Kind == "ValidatingAdmissionPolicyBinding" && selects(d, labels) {
			out = append(out, d.Spec.ValidationActions)
		}
	}
	return out
}

// TestByoAdmission_ExistingNamespaceWarnsAndNewNamespaceDenies is the rollout end to end, through
// the real renderers: the runner decides the modes, renders the namespaces, and the policy's
// bindings select them. A namespace that already exists is reached only by [Warn, Audit]; one first
// created now only by [Deny]; and a namespace this runner did not decide — "default" as a runner
// before #6446 left it — by neither.
func TestByoAdmission_ExistingNamespaceWarnsAndNewNamespaceDenies(t *testing.T) {
	modes := DecideByoAdmissionModes([]string{"byo-old", "byo-new"}, map[string]map[string]string{"byo-old": nil}, nil)
	labels := renderedNamespaceLabels(t, []string{"byo-old", "byo-new"}, nil, modes)
	docs := renderPolicyDocs(t)

	if got := bindingsSelecting(docs, labels["byo-old"]); !reflect.DeepEqual(got, [][]string{{"Warn", "Audit"}}) {
		t.Errorf("existing namespace is selected by %v, want only [Warn Audit]", got)
	}
	if got := bindingsSelecting(docs, labels["byo-new"]); !reflect.DeepEqual(got, [][]string{{"Deny"}}) {
		t.Errorf("new namespace is selected by %v, want only [Deny]", got)
	}
	legacyDefault := map[string]string{"alethia.io/managed-by": "byo-charts", "kubernetes.io/metadata.name": "default"}
	if got := bindingsSelecting(docs, legacyDefault); len(got) != 0 {
		t.Errorf("a namespace with no mode is selected by %v, want none", got)
	}
	if got := bindingsSelecting(docs, map[string]string{ByoAdmissionModeLabel: "enforce"}); len(got) != 0 {
		t.Errorf("a namespace that is not a BYO chart's is selected by %v, want none", got)
	}
}

// TestByoAdmissionPolicy_Shape: two policies, each bound once by name; the reporting one cannot
// refuse even when it fails to evaluate, the refusing one cannot admit when it fails; every rule is
// in both; and the policy reaches the three resources it reads, on CREATE and UPDATE.
func TestByoAdmissionPolicy_Shape(t *testing.T) {
	docs := renderPolicyDocs(t)
	policies := map[string]renderedPolicy{}
	bindings := map[string]renderedPolicy{}
	for _, d := range docs {
		switch d.Kind {
		case "ValidatingAdmissionPolicy":
			policies[d.Metadata.Name] = d
		case "ValidatingAdmissionPolicyBinding":
			bindings[d.Metadata.Name] = d
		default:
			t.Errorf("unexpected document kind %q", d.Kind)
		}
	}
	want := map[string]struct {
		failure string
		actions []string
	}{
		ByoAdmissionReportPolicy:  {"Ignore", []string{"Warn", "Audit"}},
		ByoAdmissionEnforcePolicy: {"Fail", []string{"Deny"}},
	}
	if len(policies) != len(want) || len(bindings) != len(want) {
		t.Fatalf("policies %d, bindings %d, want %d of each", len(policies), len(bindings), len(want))
	}
	for name, w := range want {
		p, b := policies[name], bindings[name]
		if p.Spec.FailurePolicy != w.failure {
			t.Errorf("%s failurePolicy = %q, want %q", name, p.Spec.FailurePolicy, w.failure)
		}
		if b.Spec.PolicyName != name || !reflect.DeepEqual(b.Spec.ValidationActions, w.actions) {
			t.Errorf("binding %s = policy %q actions %v, want policy %q actions %v", name, b.Spec.PolicyName, b.Spec.ValidationActions, name, w.actions)
		}
		if len(p.Spec.Validations) != len(byoAdmissionRules) {
			t.Errorf("%s has %d validations, want one per rule (%d)", name, len(p.Spec.Validations), len(byoAdmissionRules))
		}
		for i, v := range p.Spec.Validations {
			r := byoAdmissionRules[i]
			if v.Expression != r.Expression || v.Message != r.Message || v.Reason != "Forbidden" {
				t.Errorf("%s validation %d = %+v, want rule %s", name, i, v, r.ID)
			}
		}
		reached := map[string]bool{}
		for _, rr := range p.Spec.MatchConstraints.ResourceRules {
			if !reflect.DeepEqual(rr.Operations, []string{"CREATE", "UPDATE"}) || !reflect.DeepEqual(rr.APIVersions, []string{"v1"}) {
				t.Errorf("%s resource rule %+v: want CREATE, UPDATE at v1", name, rr)
			}
			for _, g := range rr.APIGroups {
				for _, res := range rr.Resources {
					reached[g+"/"+res] = true
				}
			}
		}
		for _, r := range byoAdmissionRules {
			gr := map[string]string{"Service": "/services", "Secret": "/secrets", "Ingress": "networking.k8s.io/ingresses"}[r.Kind]
			if gr == "" || !reached[gr] {
				t.Errorf("%s: rule %s reads %s, which the policy does not match (%v)", name, r.ID, r.Kind, reached)
			}
		}
		if len(p.Metadata.Labels) != 1 || len(b.Metadata.Labels) != 1 {
			t.Errorf("%s carries labels %v / %v: a cluster-scoped object shared by every environment must carry no environment's labels", name, p.Metadata.Labels, b.Metadata.Labels)
		}
	}
}

// TestByoAdmissionPolicyExpressionsNameTheirData pins the CEL half of each rule to the data its Go
// half reads. No CEL evaluator is in this module's graph, so the expressions are not EXECUTED here;
// this asserts each one is guarded by its kind and names the same field and values the Go predicate
// checks, so editing either half's data without the other fails.
func TestByoAdmissionPolicyExpressionsNameTheirData(t *testing.T) {
	byID := map[string]byoAdmissionRule{}
	for _, r := range byoAdmissionRules {
		byID[r.ID] = r
		if !strings.HasPrefix(r.Expression, "request.kind.kind != '"+r.Kind+"' || ") {
			t.Errorf("rule %s is not guarded by its kind %s: %s", r.ID, r.Kind, r.Expression)
		}
	}
	want := map[string][]string{
		"service-exposure":             {"!has(object.spec.type)", "!(object.spec.type in ['LoadBalancer', 'NodePort'])"},
		"service-external-ips":         {"!has(object.spec.externalIPs)", "size(object.spec.externalIPs) == 0"},
		"service-account-token-secret": {"!has(object.type)", "object.type != 'kubernetes.io/service-account-token'"},
		"ingress-snippet-annotation":   {"!has(object.metadata.annotations)", "object.metadata.annotations.all(k, !k.lowerAscii().contains('snippet'))"},
	}
	if len(byID) != len(want) {
		t.Errorf("rules = %d, want %d", len(byID), len(want))
	}
	for id, parts := range want {
		r, ok := byID[id]
		if !ok {
			t.Errorf("rule %s is missing", id)
			continue
		}
		for _, p := range parts {
			if !strings.Contains(r.Expression, p) {
				t.Errorf("rule %s expression does not contain %q: %s", id, p, r.Expression)
			}
		}
	}
	for _, typ := range byoForbiddenServiceTypes {
		if !strings.Contains(byID["service-exposure"].Expression, "'"+typ+"'") {
			t.Errorf("service-exposure CEL omits %s, which its Go predicate refuses", typ)
		}
	}
}

// TestByoAdmissionViolations_BothDirections drives every rule's Go predicate with an object it
// refuses and one it admits, plus an object of another kind carrying the refused field.
func TestByoAdmissionViolations_BothDirections(t *testing.T) {
	for _, tc := range []struct {
		name string
		obj  ByoAdmissionObject
		rule string // "" = admitted
		want string
	}{
		{"LoadBalancer", ByoAdmissionObject{Kind: "Service", Name: "web", ServiceType: "LoadBalancer"}, "service-exposure", `Service "web": spec.type is LoadBalancer`},
		{"NodePort", ByoAdmissionObject{Kind: "Service", Name: "web", ServiceType: "NodePort"}, "service-exposure", `Service "web": spec.type is NodePort`},
		{"ClusterIP", ByoAdmissionObject{Kind: "Service", Name: "web", ServiceType: "ClusterIP"}, "", ""},
		{"no type", ByoAdmissionObject{Kind: "Service", Name: "web"}, "", ""},
		{"ExternalName", ByoAdmissionObject{Kind: "Service", Name: "web", ServiceType: "ExternalName"}, "", ""},
		{"externalIPs", ByoAdmissionObject{Kind: "Service", Name: "web", ExternalIPs: []string{"203.0.113.7"}}, "service-external-ips", `Service "web": spec.externalIPs is set`},
		{"empty externalIPs", ByoAdmissionObject{Kind: "Service", Name: "web", ExternalIPs: []string{}}, "", ""},
		{"token Secret", ByoAdmissionObject{Kind: "Secret", Name: "tok", SecretType: "kubernetes.io/service-account-token"}, "service-account-token-secret", `Secret "tok": type is kubernetes.io/service-account-token`},
		{"Opaque Secret", ByoAdmissionObject{Kind: "Secret", Name: "tok", SecretType: "Opaque"}, "", ""},
		{"TLS Secret", ByoAdmissionObject{Kind: "Secret", Name: "tls", SecretType: "kubernetes.io/tls"}, "", ""},
		{"nginx snippet", ByoAdmissionObject{Kind: "Ingress", Name: "in", Annotations: map[string]string{"nginx.ingress.kubernetes.io/configuration-snippet": "x"}}, "ingress-snippet-annotation",
			`Ingress "in": annotation nginx.ingress.kubernetes.io/configuration-snippet configures the ingress controller with a snippet`},
		{"NGINX Inc snippets", ByoAdmissionObject{Kind: "Ingress", Name: "in", Annotations: map[string]string{"nginx.org/server-snippets": "x"}}, "ingress-snippet-annotation",
			`Ingress "in": annotation nginx.org/server-snippets configures the ingress controller with a snippet`},
		{"uppercase snippet", ByoAdmissionObject{Kind: "Ingress", Name: "in", Annotations: map[string]string{"example.com/Server-Snippet": "x"}}, "ingress-snippet-annotation",
			`Ingress "in": annotation example.com/Server-Snippet configures the ingress controller with a snippet`},
		{"ordinary annotation", ByoAdmissionObject{Kind: "Ingress", Name: "in", Annotations: map[string]string{"nginx.ingress.kubernetes.io/rewrite-target": "/"}}, "", ""},
		{"no annotations", ByoAdmissionObject{Kind: "Ingress", Name: "in"}, "", ""},
		{"snippet on a Service", ByoAdmissionObject{Kind: "Service", Name: "web", Annotations: map[string]string{"x/server-snippet": "y"}}, "", ""},
		{"type on an Ingress", ByoAdmissionObject{Kind: "Ingress", Name: "in", ServiceType: "LoadBalancer", SecretType: "kubernetes.io/service-account-token"}, "", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := ByoAdmissionViolations([]ByoAdmissionObject{tc.obj})
			if tc.rule == "" {
				if len(got) != 0 {
					t.Errorf("admitted object reported: %v", got)
				}
				return
			}
			if len(got) != 1 || got[0].Rule != tc.rule || got[0].String() != tc.want {
				t.Errorf("violations = %+v, want one %s: %s", got, tc.rule, tc.want)
			}
		})
	}
}

// TestParseNamespaceLabels reads every shape kubectl prints, and refuses output it cannot read
// rather than reporting "none exist".
func TestParseNamespaceLabels(t *testing.T) {
	for _, tc := range []struct {
		name, raw string
		want      map[string]map[string]string
	}{
		{"nothing found", "", map[string]map[string]string{}},
		{"a list", `{"kind":"List","items":[{"kind":"Namespace","metadata":{"name":"a","labels":{"x":"1"}}},{"kind":"Namespace","metadata":{"name":"b"}}]}`,
			map[string]map[string]string{"a": {"x": "1"}, "b": nil}},
		{"one object", `{"kind":"Namespace","metadata":{"name":"a","labels":{"x":"1"}}}`, map[string]map[string]string{"a": {"x": "1"}}},
	} {
		got, err := parseNamespaceLabels(tc.raw)
		if err != nil || !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s: got %v, %v; want %v", tc.name, got, err, tc.want)
		}
	}
	if _, err := parseNamespaceLabels("error: the server could not be reached"); err == nil {
		t.Error("unreadable output parsed as a result")
	}
}

// TestReadByoNamespaceLabels_AFailedReadIsAnError: a kubectl failure must reach the caller as an
// error, never as an empty map — empty means "every namespace is new", which would refuse in
// namespaces whose charts are running.
func TestReadByoNamespaceLabels_AFailedReadIsAnError(t *testing.T) {
	stub := newKubectlStub(t, 1)
	got, err := ReadByoNamespaceLabels([]string{"byo-a", "byo-a", "byo-b"})
	if err == nil {
		t.Fatalf("a failed read returned %v and no error", got)
	}
	if calls := stub.calls(); len(calls) != 1 || calls[0] != "get namespace byo-a byo-b --ignore-not-found -o json" {
		t.Errorf("calls = %q, want one deduplicated read", calls)
	}
	if _, err := ReadByoNamespaceLabels([]string{"bad name"}); err == nil {
		t.Error("a malformed namespace name reached kubectl")
	}
}

// TestAdmissionPolicyServed: the policy is used only when both its resources are served.
func TestAdmissionPolicyServed(t *testing.T) {
	both := `{"resources":[{"name":"validatingwebhookconfigurations"},{"name":"validatingadmissionpolicies"},{"name":"validatingadmissionpolicybindings"}]}`
	if ok, reason := admissionPolicyServed(both); !ok || reason != "" {
		t.Errorf("served = %v (%s), want served", ok, reason)
	}
	for _, raw := range []string{
		`{"resources":[{"name":"validatingwebhookconfigurations"},{"name":"mutatingwebhookconfigurations"}]}`,
		`{"resources":[{"name":"validatingadmissionpolicies"}]}`,
		"",
	} {
		if ok, reason := admissionPolicyServed(raw); ok || reason == "" {
			t.Errorf("admissionPolicyServed(%q) = %v %q, want unavailable with a reason", raw, ok, reason)
		}
	}
	newKubectlStub(t, 1)
	if ok, reason := ByoAdmissionPolicyAvailability(); ok || !strings.Contains(reason, "could not read") {
		t.Errorf("a failed discovery read = %v %q, want unavailable naming the failed read", ok, reason)
	}
}

// wholeOutput matches a kubectl output flag that prints whole objects.
var wholeOutput = regexp.MustCompile(`-o (json|yaml|wide)(\s|$)`)

// TestReadByoAdmissionObjects reads Services and Ingresses as JSON and Secrets by name and type only,
// so no Secret value is ever printed to the runner.
func TestReadByoAdmissionObjects(t *testing.T) {
	stub := newKubectlStub(t, 0,
		stubRule{Match: "get services -n byo-a -o json", Stdout: `{"items":[{"metadata":{"name":"web"},"spec":{"type":"LoadBalancer","externalIPs":["203.0.113.7"]}}]}`},
		stubRule{Match: "get ingresses.networking.k8s.io -n byo-a -o json", Stdout: `{"items":[{"metadata":{"name":"in","annotations":{"nginx.ingress.kubernetes.io/server-snippet":"x"}}}]}`},
		stubRule{Match: "get secrets -n byo-a", Stdout: "tok\tkubernetes.io/service-account-token\nplain\tOpaque\n"},
	)
	objs, err := ReadByoAdmissionObjects("byo-a")
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	got := ByoAdmissionViolations(objs)
	var rules []string
	for _, v := range got {
		rules = append(rules, v.Rule)
	}
	if want := []string{"service-exposure", "service-external-ips", "service-account-token-secret", "ingress-snippet-annotation"}; !reflect.DeepEqual(rules, want) {
		t.Errorf("rules = %v, want %v", rules, want)
	}
	for _, c := range stub.calls() {
		if strings.Contains(c, "secrets") && (wholeOutput.MatchString(c) || !strings.Contains(c, "-o jsonpath=")) {
			t.Errorf("secrets were read whole: %q", c)
		}
	}
	if _, err := ReadByoAdmissionObjects("bad name"); err == nil {
		t.Error("a malformed namespace name reached kubectl")
	}
	newKubectlStub(t, 1)
	if _, err := ReadByoAdmissionObjects("byo-a"); err == nil {
		t.Error("a failed read returned no error")
	}
}

// TestPreviewByoPodSecurity asks PSA through a SERVER-SIDE DRY RUN only — the namespace's labels are
// never changed by the preview — and keeps the per-pod lines.
func TestPreviewByoPodSecurity(t *testing.T) {
	out := `Warning: existing pods in namespace "byo-a" violate the new PodSecurity enforce level "baseline:v1.33"
Warning: agent-x7 (and 2 other pods): host namespaces, hostPath volumes
Warning: debug: privileged
namespace/byo-a labeled (server dry run)
`
	stub := newKubectlStub(t, 0, stubRule{Match: "label namespace byo-a", Stdout: out})
	got, err := PreviewByoPodSecurity("byo-a")
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	if want := []string{"agent-x7 (and 2 other pods): host namespaces, hostPath volumes", "debug: privileged"}; !reflect.DeepEqual(got, want) {
		t.Errorf("warnings = %q, want %q", got, want)
	}
	calls := stub.calls()
	if len(calls) != 1 || !strings.Contains(calls[0], "--dry-run=server") ||
		!strings.Contains(calls[0], "pod-security.kubernetes.io/enforce=baseline") ||
		!strings.Contains(calls[0], "pod-security.kubernetes.io/enforce-version=v1.33") {
		t.Errorf("calls = %q, want one server-side dry run of enforce=baseline at v1.33", calls)
	}
	if got := parsePodSecurityWarnings("namespace/byo-a labeled (server dry run)\n"); len(got) != 0 {
		t.Errorf("a clean namespace reported %q", got)
	}
	if _, err := PreviewByoPodSecurity("bad name"); err == nil {
		t.Error("a malformed namespace name reached kubectl")
	}
}
