// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestDedicatedDestinationsUnchanged is the regression net for the placement-activation work: the
// shared user-apps.yaml / project-infra.yaml templates are rendered on EVERY `dedicated` deploy (the
// only shipped path + the whole customer base), so they must keep their hardcoded in-cluster
// destinations. The namespace-placement path uses its own hardened renderer (namespace_tenant.go) and
// must NEVER cause these to be templated off a placement/namespace field. If a future change makes
// these destination-aware, it must do so with defaults that keep this test byte-stable.
func TestDedicatedDestinationsUnchanged(t *testing.T) {
	facts := BuildFromOutputs(map[string]interface{}{
		"eks_cluster_name":     "eks-demo",
		"eks_cluster_endpoint": "https://eks.example.com",
	}, cfg("aws"))

	outDir, err := RenderApplications(templatesDir(t), facts)
	if err != nil {
		t.Fatalf("render applications: %v", err)
	}
	defer os.RemoveAll(outDir)

	read := func(name string) string {
		b, err := os.ReadFile(filepath.Join(outDir, name))
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		return string(b)
	}

	userApps := read("user-apps.yaml")
	if !strings.Contains(userApps, "server: https://kubernetes.default.svc") {
		t.Errorf("user-apps.yaml lost its in-cluster destination:\n%s", userApps)
	}
	if !strings.Contains(userApps, `namespace: "*"`) {
		t.Errorf("user-apps.yaml lost its wildcard namespace:\n%s", userApps)
	}

	projInfra := read("project-infra.yaml")
	if !strings.Contains(projInfra, `server: "*"`) || !strings.Contains(projInfra, `namespace: "*"`) {
		t.Errorf("project-infra.yaml destinations changed:\n%s", projInfra)
	}

	// No namespace-tenant artifacts must leak into the dedicated templates.
	for _, f := range []string{userApps, projInfra} {
		if strings.Contains(f, "pod-security.kubernetes.io") || strings.Contains(f, "alethia.io/placement") {
			t.Errorf("namespace-tenant isolation leaked into a dedicated template:\n%s", f)
		}
	}
}
