// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/internal/connector"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

var (
	connectorAlibabaRegion string
	connectorAlibabaDir    string
)

const defaultAlibabaRegion = "cn-hangzhou"

var connectorAlibabaCmd = &cobra.Command{
	Use:   "alibaba",
	Short: "Connect an Alibaba Cloud account",
	Long: `Connect an Alibaba Cloud account using keyless AssumeRoleWithOIDC.

Alethia is its own OIDC issuer. You apply a small OpenTofu/Terraform module in your
Alibaba account that creates a RAM OIDC provider trusting Alethia plus a RAM role;
Alethia assumes the role with a short-lived minted assertion — no AccessKey, nothing
stored but the role ARN. Account-free: Alethia holds no Alibaba account.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		apiClient := api.NewClient(token)
		steps := []string{"Initialize", "Apply Terraform module", "Connection test"}

		ui.PrintStepper(steps, 0)
		initResp, err := initProviderIdentity(apiClient, "alibaba")
		if err != nil {
			fail(err)
		}

		ui.PrintStepper(steps, 1)
		roleArn, err := alibabaSetupFlow()
		if err != nil {
			fail(err)
		}

		ui.PrintStepper(steps, 2)
		if err := finalizeConnection(apiClient, "alibaba", initResp.IdentityID,
			map[string]interface{}{"role_arn": roleArn}); err != nil {
			fail(err)
		}

		ui.Success(fmt.Sprintf("Alibaba Cloud account connected (role %s)", roleArn))
	},
}

// alibabaSetupFlow writes the connector module to a local directory, guides the user to apply
// it in their Alibaba account (with the issuer URL of THIS control plane), and prompts for the
// resulting RAM role ARN. Alibaba has no one-liner installer, so the flow is apply-then-paste.
func alibabaSetupFlow() (string, error) {
	dir := connectorAlibabaDir
	if dir == "" {
		dir = "alethia-alibaba-connector"
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("create module dir: %w", err)
	}
	modulePath := filepath.Join(dir, "main.tf")
	if err := os.WriteFile(modulePath, []byte(connector.AlibabaConnectorModule), 0o644); err != nil {
		return "", fmt.Errorf("write module: %w", err)
	}

	region := connectorAlibabaRegion
	if region == "" {
		region = defaultAlibabaRegion
	}
	origin, _ := types.ResolveWebOrigin()
	issuer := strings.TrimRight(origin, "/") + "/api/oidc"

	ui.Info("Apply the connector module in your Alibaba account:")
	fmt.Printf("  1. Authenticate to Alibaba (aliyun CLI, or ALICLOUD_ACCESS_KEY / ALICLOUD_SECRET_KEY).\n")
	fmt.Printf("  2. Run:\n\n     cd %s\n     terraform init\n     terraform apply -var \"region=%s\" -var \"alethia_issuer_url=%s\"\n\n",
		dir, region, issuer)
	fmt.Printf("  3. Copy the %s output below.\n", ui.ValueStyle.Render("role_arn"))

	var roleArn string
	if err := ui.NewForm(huh.NewGroup(
		huh.NewInput().
			Title("RAM Role ARN").
			Placeholder("acs:ram::123456789012:role/AlethiaProvisioner").
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
	connectorCmd.AddCommand(connectorAlibabaCmd)
	connectorAlibabaCmd.Flags().StringVar(&connectorAlibabaRegion, "region", "", "Alibaba region for the RAM provider (default cn-hangzhou)")
	connectorAlibabaCmd.Flags().StringVar(&connectorAlibabaDir, "dir", "", "Directory to write the Terraform module into (default ./alethia-alibaba-connector)")
}
