package cmd

import (
	"context"
	"fmt"
	"log"
	"os"

	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/pkg/api"
	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/pkg/cloud/aws"
	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/pkg/provisioner"
	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/pkg/types"
	"github.com/charmbracelet/huh"
	"github.com/imroc/req/v3"
	"github.com/spf13/cobra"
)

var (
	vineyardID     string
	environment    string
	region         string
	vpcCidr        string
	selectedVpc    string
	bootstrapQueue bool
)

var bootstrapCmd = &cobra.Command{
	Use:   "bootstrap",
	Short: "Bootstrap a new Trellis environment on AWS",
	Long: `Bootstrap transitions a raw AWS account into a managed Trellis environment.
It provisions the necessary base infrastructure (VPC, EKS) and installs ArgoCD for GitOps reconciliation.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			log.Fatalf("Authentication failed: %v", err)
		}

		ctx := context.Background()
		apiClient := api.NewClient(token)

		var vineyardName string

		if vineyardID == "" {
			fmt.Println("Fetching your Vineyards...")
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
				fmt.Println("No Vineyards found. Please create one first via Trellis or `grape vineyard create`.")
				return
			}

			fmt.Println("Fetching existing VPCs from your AWS account...")
			ec2Client, err := aws.NewEC2Client(ctx, aws.AWSOptions{Region: region})
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

			for _, v := range vResult.Vineyards {
				if v.ID == vineyardID {
					vineyardName = v.Name
					break
				}
			}
		}

		fmt.Printf("Bootstrapping Trellis Environment...\n")
		fmt.Printf("   Vineyard ID: %s, Env: %s, Region: %s\n", vineyardID, environment, region)

		if bootstrapQueue {
			snapshot := map[string]interface{}{
				"vineyard_id":   vineyardID,
				"vineyard_name": vineyardName,
				"environment":   environment,
				"region":        region,
				"vpc_cidr":      vpcCidr,
				"selected_vpc":  selectedVpc,
			}
			job, err := apiClient.QueueJob("BOOTSTRAP", vineyardID, "", "", "", snapshot)
			if err != nil {
				log.Fatalf("Failed to queue bootstrap job: %v", err)
			}
			fmt.Printf("Queued bootstrap job (ID: %s). A worker will pick this up.\n", job.ID)
			return
		}

		result, err := provisioner.RunBootstrap(ctx, provisioner.BootstrapParams{
			VineyardID:   vineyardID,
			VineyardName: vineyardName,
			Environment:  environment,
			Region:       region,
			VpcCidr:      vpcCidr,
			SelectedVpc:  selectedVpc,
			Stdout:       os.Stdout,
			Stderr:       os.Stderr,
			ApiClient:    apiClient,
		})

		if err != nil {
			log.Fatalf("Bootstrap failed: %v", err)
		}

		if result != nil {
			fmt.Printf("\nCluster: %s (ID: %s)\n", result.ClusterName, result.ClusterID)
		}
	},
}

func init() {
	rootCmd.AddCommand(bootstrapCmd)

	bootstrapCmd.Flags().StringVarP(&vineyardID, "vineyard-id", "v", "", "ID of the Vineyard workspace")
	bootstrapCmd.Flags().StringVarP(&environment, "environment", "e", "dev", "Environment name (e.g., dev, prod)")
	bootstrapCmd.Flags().StringVarP(&region, "region", "r", "eu-central-1", "AWS Region")
	bootstrapCmd.Flags().StringVar(&vpcCidr, "vpc-cidr", "10.0.0.0/16", "CIDR block for the new VPC")
	bootstrapCmd.Flags().BoolVar(&bootstrapQueue, "queue", false, "Queue the bootstrap job for a remote worker instead of running locally")
}
