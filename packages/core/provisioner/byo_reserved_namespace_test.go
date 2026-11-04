// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// stubKubectlRecorder puts a kubectl on PATH that records every invocation and succeeds, and
// returns the path of its log. Local to this file so the test does not lean on another file's
// helper.
func stubKubectlRecorder(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	log := filepath.Join(dir, "kubectl.log")
	script := "#!/bin/sh\necho \"$@\" >> \"" + log + "\"\ncat >/dev/null\nexit 0\n"
	if err := os.WriteFile(filepath.Join(dir, "kubectl"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return log
}

// TestPrepareByoCharts_RefusesAnExistingChartInAReservedNamespace is the deploy-time half of #6439.
//
// The console refuses a reserved namespace for a NEW chart, but a chart attached before that rule
// already has its namespace stored, and reaches the runner unchanged. This pins what happens to it:
// the BYO stage is REFUSED with a reason naming the namespace — no panic, no namespace created, no
// AppProject applied (kubectl is never invoked) — and the chart stays pinned to the hardened project,
// which this deploy therefore does not create, so it has nothing to sync into.
func TestPrepareByoCharts_RefusesAnExistingChartInAReservedNamespace(t *testing.T) {
	for _, ns := range []string{"kube-system", "argocd", "external-secrets-operator", "monitoring", vclusterHostNamespacePrefix + "team-a"} {
		t.Run(ns, func(t *testing.T) {
			log := stubKubectlRecorder(t)
			vc := &types.ProjectConfig{
				ProjectName: "Acme Corp",
				AddOns: []types.AddOnInstall{
					{ID: "api", Source: "git", ChartRepo: "https://github.com/acme/charts.git", Path: "charts/api", Namespace: "payments"},
					{ID: "legacy", Source: "git", ChartRepo: "https://github.com/acme/charts.git", Path: "charts/legacy", Namespace: ns},
				},
			}
			var errOut strings.Builder
			if prepareByoCharts(vc, "tok", nil, nil, io.Discard, &errOut) {
				t.Fatalf("a BYO chart targeting reserved %q must refuse the stage", ns)
			}
			msg := errOut.String()
			if !strings.Contains(msg, "refusing to configure BYO charts") || !strings.Contains(msg, ns) || !strings.Contains(msg, "reserved") {
				t.Errorf("the refusal must say it refused, name %q and say it is reserved, got:\n%s", ns, msg)
			}
			if raw, err := os.ReadFile(log); err == nil && len(raw) > 0 {
				t.Errorf("nothing may be applied when the stage is refused; kubectl ran:\n%s", raw)
			}
			for _, a := range vc.AddOns {
				if a.Project != "byo-acme-corp" {
					t.Errorf("AddOn %s Project = %q, want the hardened project so nothing syncs into the wide-open one", a.ID, a.Project)
				}
			}
		})
	}
}

// TestByoReservedPrefixCoversVClusterHostNamespaces pins the "vcluster-" prefix in
// packages/core/argocd/byo_reserved_namespaces.json to the constant that actually names a virtual
// cluster's host namespace, which lives here rather than in argocd.
func TestByoReservedPrefixCoversVClusterHostNamespaces(t *testing.T) {
	if _, err := argocd.RenderByoNamespaces([]string{vclusterHostNamespacePrefix + "x"}, nil); err == nil || !strings.Contains(err.Error(), "reserved") {
		t.Fatalf("a vcluster host namespace (%q+name) must be reserved for BYO charts, got %v", vclusterHostNamespacePrefix, err)
	}
}
