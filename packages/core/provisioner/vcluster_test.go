// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"strings"
	"testing"
	"time"
)

func validVClusterSpec() VClusterSpec {
	return VClusterSpec{
		Name:                "team-web",
		HostNamespace:       "vcluster-team-web",
		ServiceAccount:      "vcluster-argocd-team-web",
		KubeconfigSecret:    "vcluster-kubeconfig-team-web",
		KubeconfigNamespace: "argocd",
	}
}

func TestVClusterSpecValidate(t *testing.T) {
	if err := validVClusterSpec().Validate(); err != nil {
		t.Fatalf("valid spec rejected: %v", err)
	}

	// Each shell-/YAML-bound field must fail closed on a hostile or malformed value — the guard stops a
	// snapshot value from injecting into the bash -c helm/kubectl calls.
	cases := map[string]func(*VClusterSpec){
		"bad name (space)":          func(s *VClusterSpec) { s.Name = "team web" },
		"bad name (injection)":      func(s *VClusterSpec) { s.Name = "web;rm -rf /" },
		"bad host ns (upper)":       func(s *VClusterSpec) { s.HostNamespace = "Vcluster" },
		"bad sa (dollar)":           func(s *VClusterSpec) { s.ServiceAccount = "sa$(id)" },
		"bad secret (slash)":        func(s *VClusterSpec) { s.KubeconfigSecret = "a/b" },
		"bad kubeconfig ns (empty)": func(s *VClusterSpec) { s.KubeconfigNamespace = "" },
		"bad k8s version (word)":    func(s *VClusterSpec) { s.KubernetesVersion = "latest" },
		"bad k8s version (inject)":  func(s *VClusterSpec) { s.KubernetesVersion = "1.31;x" },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			s := validVClusterSpec()
			mutate(&s)
			if err := s.Validate(); err == nil {
				t.Errorf("%s: expected validation error, got nil (must fail closed)", name)
			}
		})
	}

	// A well-formed version token passes.
	s := validVClusterSpec()
	s.KubernetesVersion = "1.31"
	if err := s.Validate(); err != nil {
		t.Errorf("version 1.31 rejected: %v", err)
	}
}

func TestInClusterAPIServerURL(t *testing.T) {
	s := validVClusterSpec()
	if got, want := s.InClusterAPIServerURL(), "https://team-web.vcluster-team-web.svc"; got != want {
		t.Errorf("InClusterAPIServerURL = %q, want %q", got, want)
	}
}

func TestRenderVClusterValues(t *testing.T) {
	// Default (no expose, no version pin): no controlPlane block; exportKubeConfig pins the in-cluster
	// server, SA-token mode, and writes the Secret into the ArgoCD namespace.
	v := renderVClusterValues(validVClusterSpec())
	for _, want := range []string{
		"exportKubeConfig:",
		"server: https://team-web.vcluster-team-web.svc",
		"serviceAccount:",
		"name: vcluster-argocd-team-web",
		"clusterRole: cluster-admin",
		"additionalSecrets:",
		"- name: vcluster-kubeconfig-team-web",
		"namespace: argocd",
	} {
		if !strings.Contains(v, want) {
			t.Errorf("default values missing %q\n---\n%s", want, v)
		}
	}
	if strings.Contains(v, "controlPlane:") {
		t.Errorf("default values should not emit an empty controlPlane block\n---\n%s", v)
	}
	if strings.Contains(v, "LoadBalancer") {
		t.Errorf("default values should not expose a LoadBalancer\n---\n%s", v)
	}

	// Expose + version pin: LoadBalancer service + the distro image tag appear.
	s := validVClusterSpec()
	s.Expose = true
	s.KubernetesVersion = "1.31"
	ve := renderVClusterValues(s)
	for _, want := range []string{"controlPlane:", "type: LoadBalancer", "tag: v1.31"} {
		if !strings.Contains(ve, want) {
			t.Errorf("expose+version values missing %q\n---\n%s", want, ve)
		}
	}

	// An explicit APIServerURL override wins over the in-cluster default.
	s2 := validVClusterSpec()
	s2.APIServerURL = "https://vc.example.com"
	if !strings.Contains(renderVClusterValues(s2), "server: https://vc.example.com") {
		t.Errorf("APIServerURL override not honored")
	}
}

func TestVClusterCommands(t *testing.T) {
	s := validVClusterSpec()

	repo := vclusterRepoAddCommand()
	if !strings.Contains(repo, "helm repo add") || !strings.Contains(repo, "charts.loft.sh") {
		t.Errorf("repo add command wrong: %q", repo)
	}

	// Install: shell-quoted release + namespace + values path; --version omitted when unpinned.
	inst := vclusterInstallCommand(s, "/tmp/vc/values.yaml", 15*time.Minute)
	for _, want := range []string{"helm upgrade --install", "'team-web'", "'loft-sh/vcluster'", "--namespace 'vcluster-team-web'", "--values '/tmp/vc/values.yaml'", "--create-namespace"} {
		if !strings.Contains(inst, want) {
			t.Errorf("install command missing %q: %q", want, inst)
		}
	}
	if strings.Contains(inst, "--version") {
		t.Errorf("install command should omit --version when unpinned: %q", inst)
	}
	s.ChartVersion = "0.20.0"
	if !strings.Contains(vclusterInstallCommand(s, "/tmp/v.yaml", time.Minute), "--version '0.20.0'") {
		t.Errorf("install command should pin --version when set")
	}

	// Uninstall + secret cleanup are idempotent (--ignore-not-found) and scoped.
	un := vclusterUninstallCommand(s)
	if !strings.Contains(un, "helm uninstall 'team-web'") || !strings.Contains(un, "--ignore-not-found") {
		t.Errorf("uninstall command wrong: %q", un)
	}
	del := vclusterDeleteSecretCommand(s)
	if !strings.Contains(del, "kubectl delete secret 'vcluster-kubeconfig-team-web'") || !strings.Contains(del, "--namespace 'argocd'") {
		t.Errorf("delete-secret command wrong: %q", del)
	}
}
