// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package k8s

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	alethiaaws "github.com/alethialabs-io/alethialabs/packages/core/cloud/aws"
	"github.com/alethialabs-io/alethialabs/packages/core/utils"
	"github.com/aws/aws-sdk-go-v2/service/eks"
	"gopkg.in/yaml.v3"
)

type K8sCLI struct {
	Profile   string
	Region    string
	DryRun    bool
	eksClient *eks.Client
}

func NewK8sCLI(opts alethiaaws.AWSOptions, dryRun bool) (*K8sCLI, error) {
	cfg, err := alethiaaws.LoadConfig(context.Background(), opts)
	if err != nil {
		return nil, fmt.Errorf("unable to load SDK config: %w", err)
	}

	return &K8sCLI{
		Profile:   opts.Profile,
		Region:    opts.Region,
		DryRun:    dryRun,
		eksClient: eks.NewFromConfig(cfg),
	}, nil
}

func (k *K8sCLI) GetContext(clusterName string, logger *utils.Logger) error {
	logger.Info(fmt.Sprintf("Getting context for cluster: %s", clusterName), "k8s")

	resp, err := k.eksClient.DescribeCluster(context.Background(), &eks.DescribeClusterInput{
		Name: &clusterName,
	})
	if err != nil {
		return fmt.Errorf("failed to describe cluster: %w", err)
	}

	cluster := resp.Cluster
	kubeconfigPath := "temp/kubeconfig"

	clusterConfig := map[string]interface{}{
		"apiVersion": "v1",
		"kind":       "Config",
		"clusters": []interface{}{
			map[string]interface{}{
				"cluster": map[string]interface{}{
					"server":                     *cluster.Endpoint,
					"certificate-authority-data": *cluster.CertificateAuthority.Data,
				},
				"name": *cluster.Arn,
			},
		},
		"contexts": []interface{}{
			map[string]interface{}{
				"context": map[string]interface{}{
					"cluster": *cluster.Arn,
					"user":    *cluster.Arn,
				},
				"name": *cluster.Arn,
			},
		},
		"current-context": *cluster.Arn,
		"preferences":     map[string]interface{}{},
		"users": []interface{}{
			map[string]interface{}{
				"name": *cluster.Arn,
				"user": map[string]interface{}{
					// CLI-free: authenticate via the runner's own kube-token exec-plugin (in-process
					// presigned STS token), not the aws-iam-authenticator binary (no longer in the image).
					"exec": map[string]interface{}{
						"apiVersion": "client.authentication.k8s.io/v1beta1",
						"command":    execSelfPath(),
						"args": []string{
							"kube-token",
							"--provider",
							"aws",
							"--cluster",
							clusterName,
							"--region",
							k.Region,
						},
					},
				},
			},
		},
	}

	data, err := yaml.Marshal(clusterConfig)
	if err != nil {
		return fmt.Errorf("failed to marshal kubeconfig: %w", err)
	}

	if err := os.MkdirAll(filepath.Dir(kubeconfigPath), 0755); err != nil {
		return fmt.Errorf("failed to create temp directory: %w", err)
	}

	if err := os.WriteFile(kubeconfigPath, data, 0600); err != nil {
		return fmt.Errorf("failed to write kubeconfig: %w", err)
	}

	logger.Info(fmt.Sprintf("Kubeconfig written to %s", kubeconfigPath), "k8s")
	return nil
}

// execSelfPath resolves the running binary's absolute path for use as a Kubernetes
// exec-credential-plugin command (the runner mints tokens in-process). Falls back to
// "runner" (PATH lookup) if the path can't be determined.
func execSelfPath() string {
	if self, err := os.Executable(); err == nil && self != "" {
		return self
	}
	return "runner"
}

func (k *K8sCLI) Apply(namespace, manifest string, env map[string]string, logger *utils.Logger) error {
	cmd := fmt.Sprintf("kubectl apply -n %s -f %s", namespace, manifest)
	logger.Info(fmt.Sprintf("Running kubectl apply command for %s", manifest), "k8s")

	serverDryRunCmd := cmd + " --dry-run=server"

	envList := make([]string, 0, len(env))
	for k, v := range env {
		envList = append(envList, fmt.Sprintf("%s=%s", strings.ToUpper(k), v))
	}

	if k.DryRun {
		logger.Info("Performing server-side dry-run...", "k8s")
		err := utils.ExecuteCommand(serverDryRunCmd, ".", envList, nil, nil)
		if err != nil {
			logger.Warn("Server-side dry-run failed. It might be expected in dry-run mode.", "k8s")
		} else {
			logger.Info("Server-side dry-run succeeded.", "k8s")
		}
	} else {
		logger.Info("Performing server-side dry-run before actual execution...", "k8s")
		err := utils.ExecuteCommand(serverDryRunCmd, ".", envList, nil, nil)
		if err != nil {
			return fmt.Errorf("server-side dry-run failed: %w", err)
		}
		logger.Info("Server-side dry-run succeeded. Proceeding with actual command.", "k8s")

		err = utils.ExecuteCommand(cmd, ".", envList, nil, nil)
		if err != nil {
			return fmt.Errorf("kubectl apply failed: %w", err)
		}
	}

	return nil
}
