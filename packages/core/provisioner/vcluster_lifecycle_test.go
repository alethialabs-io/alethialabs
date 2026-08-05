// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// stubShellToolsOnPath puts no-op `helm` and `kubectl` executables at the front of PATH so the
// provisioner's utils.CheckDependencies preflight passes without the real tools being installed.
// The commands themselves are intercepted by the executeCommand seam, so the stubs never run.
func stubShellToolsOnPath(t *testing.T) {
	t.Helper()
	bin := t.TempDir()
	for _, name := range []string{"helm", "kubectl"} {
		if err := os.WriteFile(filepath.Join(bin, name), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
			t.Fatalf("write %s stub: %v", name, err)
		}
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
}

// TestResolvedVClusterChartRepoHonoursOverride pins the internal-mirror escape hatch: the env knob
// replaces the public loft-sh repo, and an unset/blank knob falls back to the OSS default.
func TestResolvedVClusterChartRepoHonoursOverride(t *testing.T) {
	t.Setenv("ALETHIA_VCLUSTER_CHART_REPO", "  https://mirror.internal/charts  ")
	if got := ResolvedVClusterChartRepo(); got != "https://mirror.internal/charts" {
		t.Fatalf("ResolvedVClusterChartRepo = %q, want the trimmed override", got)
	}
	t.Setenv("ALETHIA_VCLUSTER_CHART_REPO", "   ")
	if got := ResolvedVClusterChartRepo(); got != defaultVClusterChartRepo {
		t.Fatalf("blank override: ResolvedVClusterChartRepo = %q, want %q", got, defaultVClusterChartRepo)
	}
}

// TestVClusterSpecResolvedDefaults covers the two "" ⇒ default resolvers on the spec.
func TestVClusterSpecResolvedDefaults(t *testing.T) {
	t.Setenv("ALETHIA_VCLUSTER_CHART_VERSION", "0.24.1")

	s := validVClusterSpec()
	if got := s.resolvedClusterRole(); got != defaultVClusterClusterRole {
		t.Errorf("resolvedClusterRole() = %q, want %q", got, defaultVClusterClusterRole)
	}
	if got := s.resolvedChartVersion(); got != "0.24.1" {
		t.Errorf("resolvedChartVersion() = %q, want the env-resolved default", got)
	}

	s.ClusterRole = "alethia-tenant"
	s.ChartVersion = "0.25.0"
	if got := s.resolvedClusterRole(); got != "alethia-tenant" {
		t.Errorf("explicit clusterRole not honoured: %q", got)
	}
	if got := s.resolvedChartVersion(); got != "0.25.0" {
		t.Errorf("explicit chartVersion not honoured: %q", got)
	}
}

// TestFmtDuration covers the helm/kubectl duration rendering, including the non-positive fallback.
func TestFmtDuration(t *testing.T) {
	cases := []struct {
		name string
		in   time.Duration
		want string
	}{
		{"positive", 90 * time.Second, "1m30s"},
		{"zero falls back", 0, "15m"},
		{"negative falls back", -time.Second, "15m"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := fmtDuration(tc.in); got != tc.want {
				t.Fatalf("fmtDuration(%s) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// TestHelmVClusterProvisionerCreate drives the helm-based Create: an invalid spec fails closed
// before any command runs, a repo-add failure is reported, and the happy path issues the repo-add
// then the install with a values file.
func TestHelmVClusterProvisionerCreate(t *testing.T) {
	prov := NewVClusterProvisioner()

	t.Run("invalid spec fails closed before any command", func(t *testing.T) {
		resetDeploySeams(t)
		ran := false
		executeCommand = func(string, string, []string, io.Writer, io.Writer) error {
			ran = true
			return nil
		}
		bad := validVClusterSpec()
		bad.Name = "web;rm -rf /"
		if err := prov.Create(context.Background(), bad, io.Discard, io.Discard); err == nil {
			t.Fatal("Create accepted a hostile spec name")
		}
		if ran {
			t.Fatal("Create shelled out despite an invalid spec")
		}
	})

	t.Run("repo add failure is reported", func(t *testing.T) {
		resetDeploySeams(t)
		stubShellToolsOnPath(t)
		executeCommand = func(string, string, []string, io.Writer, io.Writer) error {
			return errors.New("no network")
		}
		err := prov.Create(context.Background(), validVClusterSpec(), io.Discard, io.Discard)
		if err == nil || !strings.Contains(err.Error(), "loft-sh helm repo") {
			t.Fatalf("Create err = %v, want the repo-add failure", err)
		}
	})

	t.Run("install failure names the release", func(t *testing.T) {
		resetDeploySeams(t)
		stubShellToolsOnPath(t)
		n := 0
		executeCommand = func(string, string, []string, io.Writer, io.Writer) error {
			n++
			if n == 1 {
				return nil // repo add
			}
			return errors.New("timed out")
		}
		err := prov.Create(context.Background(), validVClusterSpec(), io.Discard, io.Discard)
		if err == nil || !strings.Contains(err.Error(), `helm install of "team-web" failed`) {
			t.Fatalf("Create err = %v, want the install failure", err)
		}
	})

	t.Run("happy path writes values and installs", func(t *testing.T) {
		resetDeploySeams(t)
		stubShellToolsOnPath(t)
		var commands []string
		var values string
		executeCommand = func(cmd string, _ string, _ []string, _, _ io.Writer) error {
			commands = append(commands, cmd)
			// Read the values file NOW — Create removes its temp dir on return.
			if i := strings.Index(cmd, "--values '"); i >= 0 {
				rest := cmd[i+len("--values '"):]
				if j := strings.Index(rest, "'"); j > 0 {
					b, err := os.ReadFile(rest[:j])
					if err != nil {
						t.Errorf("read values file: %v", err)
					}
					values = string(b)
				}
			}
			return nil
		}
		if err := prov.Create(context.Background(), validVClusterSpec(), io.Discard, io.Discard); err != nil {
			t.Fatalf("Create: %v", err)
		}
		if len(commands) != 2 {
			t.Fatalf("commands = %#v, want repo-add + install", commands)
		}
		if !strings.HasPrefix(commands[0], "helm repo add 'loft-sh'") {
			t.Errorf("repo-add command = %q", commands[0])
		}
		if !strings.Contains(commands[1], "helm upgrade --install 'team-web' 'loft-sh/vcluster'") {
			t.Errorf("install command = %q", commands[1])
		}
		for _, want := range []string{"exportKubeConfig:", "vcluster-argocd-team-web", "vcluster-kubeconfig-team-web"} {
			if !strings.Contains(values, want) {
				t.Errorf("values file missing %q:\n%s", want, values)
			}
		}
	})
}

// TestHelmVClusterProvisionerWaitReady covers the rollout wait: validation, failure wrapping and
// the exact kubectl command shape.
func TestHelmVClusterProvisionerWaitReady(t *testing.T) {
	prov := NewVClusterProvisioner()

	resetDeploySeams(t)
	var got string
	executeCommand = func(cmd string, _ string, _ []string, _, _ io.Writer) error {
		got = cmd
		return nil
	}
	if err := prov.WaitReady(context.Background(), validVClusterSpec(), 5*time.Minute, io.Discard, io.Discard); err != nil {
		t.Fatalf("WaitReady: %v", err)
	}
	for _, want := range []string{
		"kubectl rollout status statefulset/'team-web'",
		"--namespace 'vcluster-team-web'",
		"--timeout '5m0s'",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("WaitReady command missing %q: %s", want, got)
		}
	}

	bad := validVClusterSpec()
	bad.HostNamespace = "Bad NS"
	if err := prov.WaitReady(context.Background(), bad, time.Minute, io.Discard, io.Discard); err == nil {
		t.Error("WaitReady accepted an invalid spec")
	}

	executeCommand = func(string, string, []string, io.Writer, io.Writer) error { return errors.New("rollout stuck") }
	err := prov.WaitReady(context.Background(), validVClusterSpec(), time.Minute, io.Discard, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "did not become ready") {
		t.Fatalf("WaitReady err = %v, want the not-ready wrap", err)
	}
}

// TestHelmVClusterProvisionerResolveAPIServer covers all three outcomes of the LoadBalancer read:
// not-yet-assigned ("" with no error), an assigned address, and a read failure.
func TestHelmVClusterProvisionerResolveAPIServer(t *testing.T) {
	prov := NewVClusterProvisioner()

	cases := []struct {
		name    string
		out     string
		outErr  error
		want    string
		wantErr bool
	}{
		{"not yet assigned", "  \n", nil, "", false},
		{"assigned hostname", "lb.example.com\n", nil, "https://lb.example.com", false},
		{"read failure", "", errors.New("not found"), "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resetDeploySeams(t)
			executeCommandWithOutput = func(string, string, []string) (string, error) {
				return tc.out, tc.outErr
			}
			got, err := prov.ResolveAPIServer(context.Background(), validVClusterSpec(), io.Discard, io.Discard)
			if tc.wantErr {
				if err == nil {
					t.Fatal("expected an error")
				}
				return
			}
			if err != nil {
				t.Fatalf("ResolveAPIServer: %v", err)
			}
			if got != tc.want {
				t.Fatalf("ResolveAPIServer = %q, want %q", got, tc.want)
			}
		})
	}

	bad := validVClusterSpec()
	bad.Name = "not a name"
	if _, err := prov.ResolveAPIServer(context.Background(), bad, io.Discard, io.Discard); err == nil {
		t.Error("ResolveAPIServer accepted an invalid spec")
	}
}

// TestHelmVClusterProvisionerDeregister pins the best-effort teardown: BOTH the helm uninstall and
// the exported-Secret delete are attempted even when the first fails, and the first error is the
// one returned (a leaked standing credential is the hazard this ordering exists to avoid).
func TestHelmVClusterProvisionerDeregister(t *testing.T) {
	prov := NewVClusterProvisioner()

	t.Run("both attempted when helm uninstall fails", func(t *testing.T) {
		resetDeploySeams(t)
		var commands []string
		executeCommand = func(cmd string, _ string, _ []string, _, _ io.Writer) error {
			commands = append(commands, cmd)
			if strings.HasPrefix(cmd, "helm uninstall") {
				return errors.New("release not found")
			}
			return nil
		}
		err := prov.Deregister(context.Background(), validVClusterSpec(), io.Discard, io.Discard)
		if err == nil || !strings.Contains(err.Error(), "helm uninstall") {
			t.Fatalf("Deregister err = %v, want the helm uninstall failure", err)
		}
		if len(commands) != 2 || !strings.HasPrefix(commands[1], "kubectl delete secret") {
			t.Fatalf("commands = %#v — the exported-Secret delete must still be attempted", commands)
		}
	})

	t.Run("secret delete failure surfaces when helm succeeded", func(t *testing.T) {
		resetDeploySeams(t)
		executeCommand = func(cmd string, _ string, _ []string, _, _ io.Writer) error {
			if strings.HasPrefix(cmd, "kubectl delete secret") {
				return errors.New("forbidden")
			}
			return nil
		}
		err := prov.Deregister(context.Background(), validVClusterSpec(), io.Discard, io.Discard)
		if err == nil || !strings.Contains(err.Error(), "exported kubeconfig secret") {
			t.Fatalf("Deregister err = %v, want the Secret-delete failure", err)
		}
	})

	t.Run("clean teardown returns nil", func(t *testing.T) {
		resetDeploySeams(t)
		executeCommand = func(string, string, []string, io.Writer, io.Writer) error { return nil }
		if err := prov.Deregister(context.Background(), validVClusterSpec(), io.Discard, io.Discard); err != nil {
			t.Fatalf("Deregister: %v", err)
		}
	})

	t.Run("invalid spec fails closed", func(t *testing.T) {
		resetDeploySeams(t)
		executeCommand = func(string, string, []string, io.Writer, io.Writer) error {
			t.Error("Deregister shelled out on an invalid spec")
			return nil
		}
		bad := validVClusterSpec()
		bad.KubeconfigSecret = "Bad/Secret"
		if err := prov.Deregister(context.Background(), bad, io.Discard, io.Discard); err == nil {
			t.Fatal("Deregister accepted an invalid spec")
		}
	})
}
