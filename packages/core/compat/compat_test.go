// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package compat

import (
	"testing"
	"time"
)

// TestLoad asserts the embedded matrix parses and carries the expected sections.
func TestLoad(t *testing.T) {
	m, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if m.Version != 1 {
		t.Fatalf("version = %d, want 1", m.Version)
	}
	if m.CatalogVersion == "" {
		t.Fatal("catalog_version is empty")
	}
	for _, slug := range []string{"aws", "gcp", "azure", "hetzner", "alibaba"} {
		c, ok := m.Cloud(slug)
		if !ok || len(c.Supported) == 0 {
			t.Errorf("missing k8s_cloud entry for %q", slug)
		}
	}
	if len(m.Components) == 0 {
		t.Error("no components recorded")
	}
	if len(m.AddOnK8s) == 0 {
		t.Error("no add-on ranges recorded")
	}
}

// TestCloudDefaultsAreSupported asserts every cloud's default K8s minor is one of
// its own supported minors — the cross-field consistency invariant (mirrors the
// catalog's TestDefaultK8sVersion). A drift here is exactly what the #1217 CI
// guard will fail the build on.
func TestCloudDefaultsAreSupported(t *testing.T) {
	m := MustLoad()
	for slug, cloud := range m.K8sCloud {
		if cloud.Default == "" {
			t.Errorf("%s: empty default", slug)
			continue
		}
		def, ok := parseMinor(cloud.Default)
		if !ok {
			t.Errorf("%s: default %q is unparseable", slug, cloud.Default)
			continue
		}
		found := false
		for _, sv := range cloud.Supported {
			pv, ok := parseMinor(sv)
			if !ok {
				t.Errorf("%s: supported version %q is unparseable", slug, sv)
				continue
			}
			if pv == def {
				found = true
			}
		}
		if !found {
			t.Errorf("%s: default %q not in supported %v", slug, cloud.Default, cloud.Supported)
		}
	}
}

// TestMatrixVersionsParse asserts every recorded bound is a parseable minor (or
// empty), so the engine never silently degrades a real bound to not_evaluable.
func TestMatrixVersionsParse(t *testing.T) {
	m := MustLoad()
	check := func(label, v string) {
		if v == "" {
			return
		}
		if _, ok := parseMinor(v); !ok {
			t.Errorf("%s: %q is not a parseable Kubernetes minor", label, v)
		}
	}
	for _, comp := range m.Components {
		for _, r := range comp.Releases {
			check(comp.ID+".k8s_min", r.K8sMin)
			check(comp.ID+".k8s_max", r.K8sMax)
		}
	}
	for id, r := range m.AddOnK8s {
		check(id+".k8s_min", r.K8sMin)
		check(id+".k8s_max", r.K8sMax)
	}
}

// TestArgoCD1165Regression is the headline case: ArgoCD chart 7.1.3 (v2.11) on a
// 1.35 cluster must FAIL and block — the #1165 bug the matrix exists to catch —
// while 8.6.4 on the same cluster passes.
func TestArgoCD1165Regression(t *testing.T) {
	bad := Evaluate(Subject{
		Providers:  []string{"aws"},
		K8sVersion: "1.35",
		Components: []ComponentRef{{ID: "argocd", Version: "7.1.3"}},
	})
	ctrl := findControl(t, bad, "COMPAT-COMPONENT-ARGOCD")
	if ctrl.Status != StatusFail {
		t.Errorf("argocd 7.1.3 on 1.35 = %q, want fail", ctrl.Status)
	}
	if !bad.Blocking() {
		t.Errorf("report verdict = %q, want a blocking fail", bad.Verdict)
	}
	if len(ctrl.Findings) == 0 {
		t.Error("failing control has no finding")
	}

	good := Evaluate(Subject{
		Providers:  []string{"aws"},
		K8sVersion: "1.35",
		Components: []ComponentRef{{ID: "argocd", Version: "8.6.4"}},
	})
	if findControl(t, good, "COMPAT-COMPONENT-ARGOCD").Status != StatusPass {
		t.Errorf("argocd 8.6.4 on 1.35 = %q, want pass", good.Verdict)
	}
}

// TestAddOnHonesty asserts an enabled add-on with no recorded window reports
// not_evaluable (never a vacuous pass) with a plain-language coverage note.
func TestAddOnHonesty(t *testing.T) {
	rep := Evaluate(Subject{
		Providers:  []string{"aws"},
		K8sVersion: "1.35",
		AddOns:     []AddOnRef{{ID: "falco", Version: "4.9.0"}},
	})
	ctrl := findControl(t, rep, "COMPAT-ADDON-FALCO")
	if ctrl.Status != StatusNotEvaluable {
		t.Errorf("falco (no window) = %q, want not_evaluable", ctrl.Status)
	}
	if ctrl.Coverage == "" {
		t.Error("not_evaluable control has no coverage note")
	}
	// A single not_evaluable and no fail/warn rolls up to a not_evaluable verdict —
	// never a pass.
	if rep.Verdict != StatusNotEvaluable {
		t.Errorf("verdict = %q, want not_evaluable", rep.Verdict)
	}
}

// TestK8sCloudUnsupported asserts an off-catalog K8s minor on a cloud fails, and
// a supported one passes.
func TestK8sCloudUnsupported(t *testing.T) {
	fail := Evaluate(Subject{Providers: []string{"hetzner"}, K8sVersion: "1.34"})
	if findControl(t, fail, "COMPAT-K8S-CLOUD-HETZNER").Status != StatusFail {
		t.Error("hetzner on 1.34 should fail (only 1.35 supported)")
	}
	pass := Evaluate(Subject{Providers: []string{"aws"}, K8sVersion: "1.34"})
	if findControl(t, pass, "COMPAT-K8S-CLOUD-AWS").Status != StatusPass {
		t.Error("aws on 1.34 should pass")
	}
}

// TestUnwaived checks the override machinery: a failing control stays unwaived
// unless a valid, unexpired override covers it.
func TestUnwaived(t *testing.T) {
	rep := Evaluate(Subject{
		Providers:  []string{"aws"},
		K8sVersion: "1.35",
		Components: []ComponentRef{{ID: "argocd", Version: "7.1.3"}},
	})
	if got := rep.Unwaived(nil); len(got) != 1 || got[0] != "COMPAT-COMPONENT-ARGOCD" {
		t.Errorf("Unwaived(nil) = %v, want [COMPAT-COMPONENT-ARGOCD]", got)
	}
	ov := &Override{
		Controls: []string{"COMPAT-COMPONENT-ARGOCD"},
		Reason:   "pinning old ArgoCD for a legacy cluster",
		By:       "operator@example.com",
		Expiry:   time.Now().Add(time.Hour),
	}
	if got := rep.Unwaived(ov); len(got) != 0 {
		t.Errorf("Unwaived(valid override) = %v, want []", got)
	}
	expired := &Override{Controls: []string{"COMPAT-COMPONENT-ARGOCD"}, Expiry: time.Now().Add(-time.Hour)}
	if got := rep.Unwaived(expired); len(got) != 1 {
		t.Errorf("Unwaived(expired override) = %v, want the failing control back", got)
	}
}

// TestEmptySubject asserts an empty config rolls up to not_evaluable, never a pass.
func TestEmptySubject(t *testing.T) {
	if v := Evaluate(Subject{}).Verdict; v != StatusNotEvaluable {
		t.Errorf("empty subject verdict = %q, want not_evaluable", v)
	}
}

// findControl returns the named control or fails the test.
func findControl(t *testing.T, r *Report, id string) ControlResult {
	t.Helper()
	for _, c := range r.Controls {
		if c.ID == id {
			return c
		}
	}
	t.Fatalf("control %q not found in report (controls: %d)", id, len(r.Controls))
	return ControlResult{}
}
