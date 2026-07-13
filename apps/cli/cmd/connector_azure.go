// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/internal/cloudshell"
	"github.com/alethialabs-io/alethialabs/apps/cli/internal/connector"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

var (
	connectorAzureSubscription string
	connectorAzureManual       bool
)

var connectorAzureCmd = &cobra.Command{
	Use:   "azure",
	Short: "Connect an Azure subscription",
	Long: `Connect an Azure subscription using federated identity.

The setup creates a user-assigned managed identity in your subscription (a plain ARM
resource — no App Registration, no client secret) with a federated credential trusting
Alethia's OIDC issuer, and grants it a least-privilege role. There is no platform Entra
app: Alethia authenticates AS your managed identity, whose client id the setup prints.

By default the setup runs with your local az CLI. Use --manual to run it in
Azure Cloud Shell and paste back the tenant, client, and subscription IDs.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		apiClient := api.NewClient(token)
		steps := []string{"Subscription", "Create managed identity", "Connection test"}

		ui.PrintStepper(steps, 0)
		if connectorAzureSubscription == "" {
			if err := ui.NewForm(huh.NewGroup(
				huh.NewInput().
					Title("Azure Subscription ID").
					Description("The subscription Alethia should provision into").
					Value(&connectorAzureSubscription),
			)).Run(); err != nil {
				fail(err)
			}
		}
		connectorAzureSubscription = strings.TrimSpace(connectorAzureSubscription)
		if connectorAzureSubscription == "" {
			failf("A subscription ID is required")
		}

		initResp, err := initProviderIdentity(apiClient, "azure")
		if err != nil {
			fail(err)
		}

		ui.PrintStepper(steps, 1)
		var ids *cloudshell.AzureIDs
		if connectorAzureManual {
			ids, err = azureManualFlow(connectorAzureSubscription)
		} else {
			ids, err = azureLocalFlow(connectorAzureSubscription)
		}
		if err != nil {
			fail(err)
		}

		ui.PrintStepper(steps, 2)
		creds := map[string]interface{}{
			"tenant_id":       ids.TenantID,
			"client_id":       ids.ClientID,
			"subscription_id": ids.SubscriptionID,
		}
		if err := finalizeConnection(apiClient, "azure", initResp.IdentityID, creds); err != nil {
			fail(err)
		}

		ui.Success(fmt.Sprintf("Azure subscription %q connected", ids.SubscriptionID))
	},
}

// azureLocalFlow runs the setup script with the local az CLI. The script creates the
// managed identity in the subscription and prints its client id (captured from output).
func azureLocalFlow(subscriptionID string) (*cloudshell.AzureIDs, error) {
	if err := cloudshell.EnsureAz(); err != nil {
		ui.Error("az CLI not found on PATH")
		ui.Muted("Install it: https://learn.microsoft.com/cli/azure/install-azure-cli")
		ui.Muted("Or re-run with --manual to set it up in Azure Cloud Shell.")
		return nil, err
	}

	ui.Info("Running setup via the local az CLI...")
	return cloudshell.RunAzureSetup(connector.AzureSetupScript, subscriptionID)
}

// azureManualFlow guides the user through Azure Cloud Shell and prompts for the
// resulting tenant/client/subscription IDs. The client id is the managed identity the
// script creates in the subscription (printed in its output), not a platform app.
func azureManualFlow(subscriptionID string) (*cloudshell.AzureIDs, error) {
	ui.Info("Manual setup:")
	fmt.Printf("  Open Azure Cloud Shell (%s) and run:\n\n", ui.LinkStyle.Render(azureCloudShellURL))
	fmt.Printf(
		"     curl -sO %s/alethia-azure-setup.sh && bash alethia-azure-setup.sh %s\n\n",
		connectorBaseURL, subscriptionID,
	)
	fmt.Println("  Then paste the values it prints below.")

	ids := &cloudshell.AzureIDs{SubscriptionID: subscriptionID}
	if err := ui.NewForm(huh.NewGroup(
		huh.NewInput().Title("Tenant ID").Value(&ids.TenantID),
		huh.NewInput().Title("Client ID").Description("The managed identity's application id").Value(&ids.ClientID),
		huh.NewInput().Title("Subscription ID").Value(&ids.SubscriptionID),
	)).Run(); err != nil {
		return nil, err
	}

	ids.TenantID = strings.TrimSpace(ids.TenantID)
	ids.ClientID = strings.TrimSpace(ids.ClientID)
	ids.SubscriptionID = strings.TrimSpace(ids.SubscriptionID)
	if ids.TenantID == "" || ids.ClientID == "" || ids.SubscriptionID == "" {
		return nil, fmt.Errorf("tenant, client, and subscription IDs are all required")
	}
	return ids, nil
}

func init() {
	connectorCmd.AddCommand(connectorAzureCmd)
	connectorAzureCmd.Flags().StringVar(&connectorAzureSubscription, "subscription", "", "Azure subscription ID")
	connectorAzureCmd.Flags().BoolVar(&connectorAzureManual, "manual", false, "Run setup in Azure Cloud Shell and paste the result")
}
