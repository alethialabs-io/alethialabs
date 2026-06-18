// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"context"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"text/template"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/assets"
	"github.com/alethialabs-io/alethialabs/packages/core/terraform"
	"github.com/alethialabs-io/alethialabs/packages/core/utils"
)

type BootstrapParams struct {
	VineyardID   string
	VineyardName string
	Environment  string
	Region       string
	VpcCidr      string
	SelectedVpc  string
	Stdout       io.Writer
	Stderr       io.Writer
	ApiClient    *api.Client
}

type BootstrapResult struct {
	ClusterName string
	ClusterID   string
	AgentToken  string
	Outputs     map[string]interface{}
}

func RunBootstrap(ctx context.Context, params BootstrapParams) (*BootstrapResult, error) {
	out := params.Stdout
	if out == nil {
		out = os.Stdout
	}

	workspaceName := fmt.Sprintf("%s-%s", params.VineyardName, params.Environment)
	if params.VineyardName == "" {
		workspaceName = fmt.Sprintf("%s-%s", params.VineyardID, params.Environment)
	}

	if params.VpcCidr == "" {
		params.VpcCidr = "10.0.0.0/16"
	}

	var job *api.BootstrapJob
	var remoteLogger *utils.RemoteLogger

	if params.ApiClient != nil {
		var err error
		job, err = params.ApiClient.CreateBootstrapJob(params.VineyardID)
		if err != nil {
			return nil, fmt.Errorf("failed to initialize bootstrap job: %w", err)
		}

		remoteLogger = utils.NewRemoteLogger(params.ApiClient, job.ID)
		out = remoteLogger
	}

	defer func() {
		if remoteLogger != nil {
			remoteLogger.Close()
		}
		if params.ApiClient != nil && job != nil {
			if r := recover(); r != nil {
				params.ApiClient.UpdateBootstrapJobStatus(job.ID, "FAILED", fmt.Sprintf("panic: %v", r))
			}
		}
	}()

	home, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("failed to get home directory: %w", err)
	}

	workDir := filepath.Join(home, ".alethia", "workspaces", workspaceName)
	if err := os.MkdirAll(workDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create workspace directory: %w", err)
	}

	fmt.Fprintf(out, "   Workspace: %s\n", workDir)

	if err := extractAssets(workDir); err != nil {
		return nil, fmt.Errorf("failed to extract assets: %w", err)
	}

	tf, err := terraform.NewTerraformCLI(ctx, "1.7.4", workDir, out, out)
	if err != nil {
		return nil, fmt.Errorf("failed to initialize Terraform CLI: %w", err)
	}

	if err := tf.Init(ctx, nil, false); err != nil {
		return nil, fmt.Errorf("terraform init failed: %w", err)
	}

	if err := createTfvars(workDir, workspaceName, params); err != nil {
		return nil, fmt.Errorf("failed to create tfvars: %w", err)
	}

	fmt.Fprintln(out, "   Provisioning Seed Infrastructure (this may take 15-20 mins)...")

	planFile := filepath.Join(workDir, "tfplan")
	if _, err := tf.Plan(ctx, "terraform.tfvars", planFile); err != nil {
		return nil, fmt.Errorf("terraform plan failed: %w", err)
	}

	if err := tf.Apply(ctx, planFile); err != nil {
		return nil, fmt.Errorf("terraform apply failed: %w", err)
	}

	outputs, err := tf.Output(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get outputs: %w", err)
	}

	fmt.Fprintln(out, "   Infrastructure Provisioned Successfully!")
	clusterName := fmt.Sprintf("%v", outputs["cluster_name"])
	fmt.Fprintf(out, "      Cluster: %s\n", clusterName)
	fmt.Fprintf(out, "      Endpoint: %v\n", outputs["cluster_endpoint"])

	result := &BootstrapResult{
		ClusterName: clusterName,
		Outputs:     outputs,
	}

	if params.ApiClient != nil {
		fmt.Fprintln(out, "   Registering Cluster with Alethia...")

		finalVpcID := ""
		if params.SelectedVpc != "new" {
			finalVpcID = params.SelectedVpc
		}

		regResp, err := params.ApiClient.RegisterCluster(clusterName, finalVpcID, params.VpcCidr, params.Region, params.VineyardID)
		if err != nil {
			return nil, fmt.Errorf("failed to register cluster: %w", err)
		}

		result.ClusterID = regResp.ClusterID
		result.AgentToken = regResp.AgentToken
		fmt.Fprintf(out, "      Cluster ID: %s\n", regResp.ClusterID)
	}

	fmt.Fprintln(out, "   Configuring kubectl context...")
	updateKubeconfigCmd := fmt.Sprintf("aws eks update-kubeconfig --region %s --name %s", params.Region, clusterName)
	if err := utils.ExecuteCommand(updateKubeconfigCmd, workDir, nil, out, out); err != nil {
		return nil, fmt.Errorf("failed to update kubeconfig: %w", err)
	}

	fmt.Fprintln(out, "   Installing ArgoCD...")
	addRepoCmd := "helm repo add argo https://argoproj.github.io/argo-helm && helm repo update"
	if err := utils.ExecuteCommand(addRepoCmd, workDir, nil, out, out); err != nil {
		return nil, fmt.Errorf("failed to add ArgoCD helm repo: %w", err)
	}

	installArgoCmd := "helm upgrade --install argo-cd argo/argo-cd --namespace argocd --create-namespace --version 7.1.3"
	if err := utils.ExecuteCommand(installArgoCmd, workDir, nil, out, out); err != nil {
		return nil, fmt.Errorf("failed to install ArgoCD: %w", err)
	}

	fmt.Fprintln(out, "   ArgoCD Installed successfully!")
	fmt.Fprintln(out, "   Bootstrap completed. Cluster is ready for GitOps configurations.")

	if params.ApiClient != nil && job != nil {
		params.ApiClient.UpdateBootstrapJobStatus(job.ID, "SUCCESS", "")
	}

	return result, nil
}

func extractAssets(destDir string) error {
	fsys := assets.Assets

	dirs := map[string]string{
		"terraform/seed": ".",
		"helm/runner":   "helm/runner",
	}

	for srcRoot, destRel := range dirs {
		err := fs.WalkDir(fsys, srcRoot, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}

			relPath, err := filepath.Rel(srcRoot, path)
			if err != nil {
				return err
			}

			if relPath == "." {
				return nil
			}

			finalDest := filepath.Join(destDir, destRel, relPath)

			if d.IsDir() {
				return os.MkdirAll(finalDest, 0755)
			}

			data, err := fsys.ReadFile(path)
			if err != nil {
				return err
			}

			if err := os.MkdirAll(filepath.Dir(finalDest), 0755); err != nil {
				return err
			}

			return os.WriteFile(finalDest, data, 0644)
		})
		if err != nil {
			return err
		}
	}
	return nil
}

func createTfvars(dir, name string, params BootstrapParams) error {
	tfvarsPath := filepath.Join(dir, "terraform.tfvars")

	tmplContent := `project_name = "{{.ProjectName}}"
environment  = "{{.Environment}}"
region       = "{{.Region}}"
vpc_cidr     = "{{.VpcCidr}}"
vpc_id       = "{{.VpcId}}"
`
	tmpl, err := template.New("tfvars").Parse(tmplContent)
	if err != nil {
		return err
	}

	f, err := os.Create(tfvarsPath)
	if err != nil {
		return err
	}
	defer f.Close()

	vpcID := ""
	if params.SelectedVpc != "new" {
		vpcID = params.SelectedVpc
	}

	data := struct {
		ProjectName string
		Environment string
		Region      string
		VpcCidr     string
		VpcId       string
	}{
		ProjectName: name,
		Environment: params.Environment,
		Region:      params.Region,
		VpcCidr:     params.VpcCidr,
		VpcId:       vpcID,
	}

	return tmpl.Execute(f, data)
}
