// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"net/url"
	"os"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/internal/cloudshell"
	"github.com/alethialabs-io/alethialabs/apps/cli/internal/connector"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

var (
	connectorAwsRegion   string
	connectorAwsRoleName string
	connectorAwsManual   bool
)

const defaultAwsRoleName = "AlethiaProvisionerRole"

var connectorAwsCmd = &cobra.Command{
	Use:   "aws",
	Short: "Connect an AWS account",
	Long: `Connect an AWS account using a cross-account IAM role.

Alethia generates a unique external id and deploys a CloudFormation stack that
creates a role trusting the Alethia platform account under that external id.

By default the stack is deployed with your local aws CLI. Use --manual to deploy
it from the AWS console and paste back the role ARN.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fmt.Println(err)
			os.Exit(1)
		}
		apiClient := api.NewClient(token)
		steps := []string{"Initialize", "Create IAM role", "Connection test"}

		ui.PrintStepper(steps, 0)
		initResp, err := initProviderIdentity(apiClient, "aws")
		if err != nil {
			ui.Error(err.Error())
			os.Exit(1)
		}
		if initResp.ExternalID == "" {
			ui.Error("Backend did not return an external id")
			os.Exit(1)
		}

		ui.PrintStepper(steps, 1)
		var roleArn string
		if connectorAwsManual {
			roleArn, err = awsManualFlow(initResp.ExternalID)
		} else {
			roleArn, err = awsLocalFlow(initResp.ExternalID)
		}
		if err != nil {
			ui.Error(err.Error())
			os.Exit(1)
		}

		ui.PrintStepper(steps, 2)
		if err := finalizeConnection(apiClient, "aws", initResp.IdentityID,
			map[string]interface{}{"role_arn": roleArn}); err != nil {
			ui.Error(err.Error())
			os.Exit(1)
		}

		ui.Success(fmt.Sprintf("AWS account connected (role %s)", roleArn))
	},
}

// awsLocalFlow deploys the CloudFormation stack with the local aws CLI and
// returns the created role ARN.
func awsLocalFlow(externalID string) (string, error) {
	if err := cloudshell.EnsureAws(); err != nil {
		ui.Error("aws CLI not found on PATH")
		ui.Muted("Install it: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html")
		ui.Muted("Or re-run with --manual to deploy from the AWS console.")
		return "", err
	}

	roleName := connectorAwsRoleName
	if roleName == "" {
		roleName = defaultAwsRoleName
	}

	ui.Info("Deploying the CloudFormation stack via the local aws CLI...")
	return cloudshell.RunAwsBootstrap(
		connector.AwsBootstrapTemplate,
		externalID,
		connectorAwsRegion,
		roleName,
		"AlethiaConnect",
	)
}

// awsManualFlow prints a CloudFormation quick-create link and prompts for the
// resulting role ARN.
func awsManualFlow(externalID string) (string, error) {
	templateURL := connectorBaseURL + "/alethia-bootstrap.yaml"
	quickCreate := fmt.Sprintf(
		"https://console.aws.amazon.com/cloudformation/home#/stacks/quickcreate?templateURL=%s&stackName=AlethiaConnect&param_ExternalId=%s&param_AlethiaAwsAccountId=%s",
		url.QueryEscape(templateURL), url.QueryEscape(externalID), alethiaAwsAccount,
	)

	ui.Info("Manual setup:")
	fmt.Printf("  1. Open the CloudFormation quick-create link:\n\n     %s\n\n", ui.LinkStyle.Render(quickCreate))
	fmt.Printf("     External ID: %s\n", ui.ValueStyle.Render(externalID))
	fmt.Println("  2. Create the stack, then copy its RoleArn output below.")

	var roleArn string
	if err := huh.NewForm(huh.NewGroup(
		huh.NewInput().
			Title("Role ARN").
			Placeholder("arn:aws:iam::123456789012:role/AlethiaProvisionerRole-...").
			Value(&roleArn),
	)).Run(); err != nil {
		return "", err
	}
	roleArn = strings.TrimSpace(roleArn)
	if roleArn == "" {
		return "", fmt.Errorf("no Role ARN provided")
	}
	return roleArn, nil
}

func init() {
	connectorCmd.AddCommand(connectorAwsCmd)
	connectorAwsCmd.Flags().StringVar(&connectorAwsRegion, "region", "", "AWS region for the CloudFormation stack")
	connectorAwsCmd.Flags().StringVar(&connectorAwsRoleName, "role-name", defaultAwsRoleName, "Name for the cross-account IAM role")
	connectorAwsCmd.Flags().BoolVar(&connectorAwsManual, "manual", false, "Deploy from the AWS console and paste the role ARN")
}
