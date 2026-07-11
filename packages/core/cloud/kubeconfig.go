// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"fmt"
	"io"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

// runnerBinaryPath resolves the absolute path of the running binary, for use as a
// Kubernetes exec-credential-plugin `command`. Falls back to "runner" (PATH lookup)
// only if the executable path can't be determined. An absolute path avoids a PATH
// hijack from the (writable) job workdir.
func runnerBinaryPath() string {
	if self, err := os.Executable(); err == nil && self != "" {
		return self
	}
	return "runner"
}

// writeExecKubeconfig writes a kubeconfig whose user authenticates via a Kubernetes
// exec-credential-plugin — the runner's own binary invoked as `<self> kube-token …`,
// which mints a short-lived cluster token in-process from the already-active keyless
// credentials (no cloud CLI). Replaces the per-cloud aws-iam-authenticator/gcloud/az
// dependency. Written to an absolute, HOME-based path (each concurrent worker has a
// private HOME) and pointed at by KUBECONFIG so the subsequent helm/kubectl calls use it.
//
// `caData` is the base64-encoded cluster CA (as EKS DescribeCluster / the GKE & AKS tofu
// outputs return it). `execArgs` is the full `kube-token …` argument vector.
func writeExecKubeconfig(name, endpoint, caData string, execArgs []string, stdout io.Writer) error {
	if endpoint == "" {
		return fmt.Errorf("no cluster endpoint for kubeconfig")
	}
	if caData == "" {
		return fmt.Errorf("no cluster CA certificate for kubeconfig")
	}
	self := runnerBinaryPath()
	kubeconfig := map[string]any{
		"apiVersion": "v1",
		"kind":       "Config",
		"clusters": []any{map[string]any{
			"name": name,
			"cluster": map[string]any{
				"server":                     endpoint,
				"certificate-authority-data": caData,
			},
		}},
		"contexts": []any{map[string]any{
			"name":    name,
			"context": map[string]any{"cluster": name, "user": name},
		}},
		"current-context": name,
		"users": []any{map[string]any{
			"name": name,
			"user": map[string]any{
				"exec": map[string]any{
					"apiVersion": "client.authentication.k8s.io/v1beta1",
					"command":    self,
					"args":       execArgs,
				},
			},
		}},
	}

	data, err := yaml.Marshal(kubeconfig)
	if err != nil {
		return fmt.Errorf("failed to marshal kubeconfig: %w", err)
	}

	// Absolute, HOME-based path (not cwd-relative) so concurrent worker subprocesses —
	// which share a cwd but each have a private HOME — never read each other's kubeconfig.
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		home = os.TempDir()
	}
	kubeDir := filepath.Join(home, ".alethia")
	if err := os.MkdirAll(kubeDir, 0700); err != nil {
		return err
	}
	kubeconfigPath := filepath.Join(kubeDir, "kubeconfig")
	if err := os.WriteFile(kubeconfigPath, data, 0600); err != nil {
		return err
	}
	_ = os.Setenv("KUBECONFIG", kubeconfigPath)
	fmt.Fprintf(stdout, "Kubeconfig written to %s (exec-plugin auth: %s %v)\n", kubeconfigPath, self, execArgs)
	return nil
}
