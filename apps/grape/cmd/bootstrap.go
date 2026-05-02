package cmd

import (
	"context"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"text/template"

	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/api"
	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/aws"
	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/internal/assets"
	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/terraform"
	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/types"
	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/utils"
	"github.com/charmbracelet/huh"
	"github.com/imroc/req/v3"
	"github.com/spf13/cobra"
)

var (
	vineyardID  string
	environment string
	region      string
	vpcCidr     string
	selectedVpc string
)

var bootstrapCmd = &cobra.Command{
	Use:   "bootstrap",
	Short: "Bootstrap a new Trellis environment on AWS",
	Long: `Bootstrap transitions a raw AWS account into a managed Trellis environment.
It provisions the necessary base infrastructure (VPC, EKS) and installs the Tendril agent.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			log.Fatalf("Authentication failed: %v", err)
		}

		ctx := context.Background()
		apiClient := api.NewClient(token)

		var vineyardName string

		// Interactive Mode if vineyard is missing
		if vineyardID == "" {
			// Fetch existing Vineyards
			fmt.Println("🔍 Fetching your Vineyards...")
			var vResult struct {
				Vineyards []types.Vineyard `json:"vineyards"`
			}
			webOrigin := os.Getenv("GRAPE_WEB_ORIGIN")
			if webOrigin == "" {
				webOrigin = "https://adp.prod.itgix.eu"
			}
			reqClient := req.C()
			_, err := reqClient.R().
				SetBearerAuthToken(token).
				SetSuccessResult(&vResult).
				Get(fmt.Sprintf("%s/api/cli/vineyards", webOrigin))

			var vineyardOptions []huh.Option[string]
			if err == nil && len(vResult.Vineyards) > 0 {
				for _, v := range vResult.Vineyards {
					vineyardOptions = append(vineyardOptions, huh.NewOption(v.Name, v.ID))
				}
			} else if err != nil {
				fmt.Printf("Warning: Failed to fetch vineyards: %v\n", err)
			}

			if len(vineyardOptions) == 0 {
				fmt.Println("❌ No Vineyards found. Please create one first via Trellis or `grape vineyard create`.")
				return
			}

			// Fetch existing VPCs
			fmt.Println("🔍 Fetching existing VPCs from your AWS account...")
			ec2Client, err := aws.NewEC2Client(ctx, region)
			var vpcOptions []huh.Option[string]
			vpcOptions = append(vpcOptions, huh.NewOption("Create New VPC", "new"))

			if err == nil {
				vpcs, _ := ec2Client.ListVPCs(ctx)
				for _, v := range vpcs {
					label := fmt.Sprintf("%s (%s) - %s", v.ID, v.CIDR, v.Name)
					if v.IsDefault {
						label += " [Default]"
					}
					vpcOptions = append(vpcOptions, huh.NewOption(label, v.ID))
				}
			}

			form := huh.NewForm(
				huh.NewGroup(
					huh.NewSelect[string]().
						Title("Vineyard Workspace").
						Description("Select the Vineyard this cluster belongs to").
						Options(vineyardOptions...).
						Value(&vineyardID),
					huh.NewSelect[string]().
						Title("Environment Stage").
						Options(
							huh.NewOption("Development", "dev"),
							huh.NewOption("Staging", "staging"),
							huh.NewOption("Production", "prod"),
						).
						Value(&environment),
					huh.NewSelect[string]().
						Title("AWS Region").
						Options(
							huh.NewOption("Europe (Frankfurt)", "eu-central-1"),
							huh.NewOption("Europe (Ireland)", "eu-west-1"),
							huh.NewOption("US East (N. Virginia)", "us-east-1"),
							huh.NewOption("US West (Oregon)", "us-west-2"),
						).
						Value(&region),
					huh.NewSelect[string]().
						Title("VPC Selection").
						Description("Choose an existing VPC or create a new one").
						Options(vpcOptions...).
						Value(&selectedVpc),
				),
				huh.NewGroup(
					huh.NewInput().
						Title("VPC CIDR").
						Description("CIDR block for the new VPC").
						Value(&vpcCidr).
						Validate(func(str string) error {
							if str == "" {
								return fmt.Errorf("CIDR cannot be empty")
							}
							return nil
						}),
				).WithHideFunc(func() bool {
					return selectedVpc != "new"
				}),
			)

			err = form.Run()
			if err != nil {
				fmt.Println("Cancelled.")
				return
			}

			// Get Vineyard name for tagging
			for _, v := range vResult.Vineyards {
				if v.ID == vineyardID {
					vineyardName = v.Name
					break
				}
			}
		}

		if vpcCidr == "" {
			vpcCidr = "10.0.0.0/16"
		}

		fmt.Println("🚀 Bootstrapping Trellis Environment...")
		fmt.Printf("   Vineyard ID: %s, Env: %s, Region: %s\n", vineyardID, environment, region)
		if selectedVpc == "new" {
			fmt.Printf("   VPC: Creating New (%s)\n", vpcCidr)
		} else {
			fmt.Printf("   VPC: Using Existing (%s)\n", selectedVpc)
		}

		// 1. Prepare Workspace
		home, err := os.UserHomeDir()
		if err != nil {
			log.Fatalf("Failed to get home directory: %v", err)
		}

		workspaceName := fmt.Sprintf("%s-%s", vineyardName, environment)
		if vineyardName == "" {
			workspaceName = fmt.Sprintf("%s-%s", vineyardID, environment)
		}

		// Initialize Remote Logger via API
		fmt.Println("   📝 Initializing Bootstrap Job...")
		job, err := apiClient.CreateBootstrapJob(vineyardID)
		if err != nil {
			log.Fatalf("Failed to initialize bootstrap job: %v", err)
		}
		
		remoteLogger := utils.NewRemoteLogger(apiClient, job.ID)
		defer func() {
			if r := recover(); r != nil {
				apiClient.UpdateBootstrapJobStatus(job.ID, "FAILED", fmt.Sprintf("panic: %v", r))
			} else {
				apiClient.UpdateBootstrapJobStatus(job.ID, "SUCCESS", "")
			}
			remoteLogger.Close()
		}()

		workDir := filepath.Join(home, ".grape", "workspaces", workspaceName)
		if err := os.MkdirAll(workDir, 0755); err != nil {
			log.Fatalf("Failed to create workspace directory: %v", err)
		}

		fmt.Fprintf(remoteLogger, "   📂 Workspace: %s\n", workDir)
		// 2. Extract Embedded Terraform Assets
		err = extractAssets(workDir)
		if err != nil {
			log.Fatalf("Failed to extract assets: %v", err)
		}

		// 3. Initialize Terraform
		tf, err := terraform.NewTF_CLI("1.7.4")
		if err != nil {
			log.Fatalf("Failed to initialize Terraform CLI: %v", err)
		}

		// 4. Terraform Init
		if err := tf.Init(workDir, "", false); err != nil {
			log.Fatalf("Terraform init failed: %v", err)
		}

		// 5. Create tfvars
		if err := createTfvars(workDir, workspaceName); err != nil {
			log.Fatalf("Failed to create tfvars: %v", err)
		}

		// 6. Terraform Apply
		fmt.Fprintln(remoteLogger, "   ⚡ Provisioning Seed Infrastructure (this may take 15-20 mins)...")

		planFile := filepath.Join(workDir, "tfplan")
		if err := tf.Plan(workDir, "terraform.tfvars", planFile); err != nil {
			log.Fatalf("Terraform plan failed: %v", err)
		}

		if err := tf.Apply(workDir, planFile); err != nil {
			log.Fatalf("Terraform apply failed: %v", err)
		}

		// 7. Get Outputs
		outputs, err := tf.Output(workDir, "")
		if err != nil {
			log.Fatalf("Failed to get outputs: %v", err)
		}

		fmt.Fprintln(remoteLogger, "   ✅ Infrastructure Provisioned Successfully!")
		clusterName := fmt.Sprintf("%v", outputs["cluster_name"])
		fmt.Fprintf(remoteLogger, "      Cluster: %s\n", clusterName)
		fmt.Fprintf(remoteLogger, "      Endpoint: %v\n", outputs["cluster_endpoint"])

		// 8. Agent Registration
		fmt.Fprintln(remoteLogger, "   🔐 Registering Cluster with Trellis...")

		finalVpcID := ""
		if selectedVpc != "new" {
			finalVpcID = selectedVpc
		}

		regResp, err := apiClient.RegisterCluster(clusterName, finalVpcID, vpcCidr, region, vineyardID)
		if err != nil {
			log.Fatalf("Failed to register cluster: %v", err)
		}

		fmt.Fprintf(remoteLogger, "      Cluster ID: %s\n", regResp.ClusterID)

		// 9. Configure kubectl
		fmt.Fprintln(remoteLogger, "   🔌 Configuring kubectl context...")
		updateKubeconfigCmd := fmt.Sprintf("aws eks update-kubeconfig --region %s --name %s", region, clusterName)
		if err := utils.ExecuteCommand(updateKubeconfigCmd, workDir, nil, remoteLogger, remoteLogger); err != nil {
			log.Fatalf("Failed to update kubeconfig: %v", err)
		}

		// 10. Install ArgoCD via Helm
		fmt.Fprintln(remoteLogger, "   📦 Installing ArgoCD...")

		// Add ArgoCD Helm repository
		addRepoCmd := "helm repo add argo https://argoproj.github.io/argo-helm && helm repo update"
		if err := utils.ExecuteCommand(addRepoCmd, workDir, nil, remoteLogger, remoteLogger); err != nil {
			log.Fatalf("Failed to add ArgoCD helm repo: %v", err)
		}

		// Install ArgoCD
		installArgoCmd := "helm upgrade --install argo-cd argo/argo-cd --namespace argocd --create-namespace --version 7.1.3"
		if err := utils.ExecuteCommand(installArgoCmd, workDir, nil, remoteLogger, remoteLogger); err != nil {
			log.Fatalf("Failed to install ArgoCD: %v", err)
		}

		fmt.Fprintln(remoteLogger, "   ✅ ArgoCD Installed successfully!")
		fmt.Fprintln(remoteLogger, "   Bootstrap completed. Cluster is ready for GitOps configurations.")
	},
}

func init() {
	rootCmd.AddCommand(bootstrapCmd)

	bootstrapCmd.Flags().StringVarP(&vineyardID, "vineyard-id", "v", "", "ID of the Vineyard workspace")
	bootstrapCmd.Flags().StringVarP(&environment, "environment", "e", "dev", "Environment name (e.g., dev, prod)")
	bootstrapCmd.Flags().StringVarP(&region, "region", "r", "eu-central-1", "AWS Region")
	bootstrapCmd.Flags().StringVar(&vpcCidr, "vpc-cidr", "10.0.0.0/16", "CIDR block for the new VPC")
}

func extractAssets(destDir string) error {
	fsys := assets.Assets

	// Map of source directory in embed -> destination directory relative to workspace
	dirs := map[string]string{
		"terraform/seed": ".",
		"helm/tendril":   "helm/tendril",
	}

	for srcRoot, destRel := range dirs {
		err := fs.WalkDir(fsys, srcRoot, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}

			// Get path relative to the source root
			relPath, err := filepath.Rel(srcRoot, path)
			if err != nil {
				return err
			}

			if relPath == "." {
				return nil
			}

			// Construct destination path
			finalDest := filepath.Join(destDir, destRel, relPath)

			if d.IsDir() {
				return os.MkdirAll(finalDest, 0755)
			}

			data, err := fsys.ReadFile(path)
			if err != nil {
				return err
			}

			// Ensure parent directory exists
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

func createTfvars(dir, name string) error {
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
	if selectedVpc != "new" {
		vpcID = selectedVpc
	}

	data := struct {
		ProjectName string
		Environment string
		Region      string
		VpcCidr     string
		VpcId       string
	}{
		ProjectName: name,
		Environment: environment,
		Region:      region,
		VpcCidr:     vpcCidr,
		VpcId:       vpcID,
	}

	return tmpl.Execute(f, data)
}
