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

The setup creates a service principal for Alethia's multi-tenant app (which trusts
Alethia's OIDC issuer via a federated credential — no client secret) in your tenant
and grants it a least-privilege role on the subscription. Alethia's platform app id
is supplied automatically; you never enter it.

By default the setup runs with your local az CLI. Use --manual to run it in
Azure Cloud Shell and paste back the tenant and subscription IDs.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		apiClient := api.NewClient(token)
		steps := []string{"Subscription", "Create app registration", "Connection test"}

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

		// Alethia's platform Entra app id — the setup script requires it as ALETHIA_AZURE_CLIENT_ID.
		// It's server-provided (fixed, non-secret); the customer never types it. Empty means this
		// instance hasn't registered the Azure app, so a connect can only fail.
		clientID := strings.TrimSpace(initResp.PlatformClientID)
		if clientID == "" {
			failf("This Alethia instance hasn't configured Azure connect (no platform app id set). Contact your Alethia operator.")
		}

		ui.PrintStepper(steps, 1)
		var ids *cloudshell.AzureIDs
		if connectorAzureManual {
			ids, err = azureManualFlow(connectorAzureSubscription, clientID)
		} else {
			ids, err = azureLocalFlow(connectorAzureSubscription, clientID)
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

// azureLocalFlow runs the setup script with the local az CLI, injecting Alethia's
// platform app id (clientID) the script requires.
func azureLocalFlow(subscriptionID, clientID string) (*cloudshell.AzureIDs, error) {
	if err := cloudshell.EnsureAz(); err != nil {
		ui.Error("az CLI not found on PATH")
		ui.Muted("Install it: https://learn.microsoft.com/cli/azure/install-azure-cli")
		ui.Muted("Or re-run with --manual to set it up in Azure Cloud Shell.")
		return nil, err
	}

	ui.Info("Running setup via the local az CLI...")
	return cloudshell.RunAzureSetup(connector.AzureSetupScript, subscriptionID, clientID)
}

// azureManualFlow guides the user through Azure Cloud Shell and prompts for the
// resulting tenant/subscription IDs. The client id is Alethia's fixed platform app
// id (clientID) — baked into the printed command, never entered by the user.
func azureManualFlow(subscriptionID, clientID string) (*cloudshell.AzureIDs, error) {
	ui.Info("Manual setup:")
	fmt.Printf("  Open Azure Cloud Shell (%s) and run:\n\n", ui.LinkStyle.Render(azureCloudShellURL))
	fmt.Printf(
		"     curl -sO %s/alethia-azure-setup.sh && ALETHIA_AZURE_CLIENT_ID=%s bash alethia-azure-setup.sh %s\n\n",
		connectorBaseURL, clientID, subscriptionID,
	)
	fmt.Println("  Then paste the values it prints below.")

	ids := &cloudshell.AzureIDs{SubscriptionID: subscriptionID, ClientID: clientID}
	if err := ui.NewForm(huh.NewGroup(
		huh.NewInput().Title("Tenant ID").Value(&ids.TenantID),
		huh.NewInput().Title("Subscription ID").Value(&ids.SubscriptionID),
	)).Run(); err != nil {
		return nil, err
	}

	ids.TenantID = strings.TrimSpace(ids.TenantID)
	ids.SubscriptionID = strings.TrimSpace(ids.SubscriptionID)
	if ids.TenantID == "" || ids.SubscriptionID == "" {
		return nil, fmt.Errorf("tenant and subscription IDs are both required")
	}
	return ids, nil
}

func init() {
	connectorCmd.AddCommand(connectorAzureCmd)
	connectorAzureCmd.Flags().StringVar(&connectorAzureSubscription, "subscription", "", "Azure subscription ID")
	connectorAzureCmd.Flags().BoolVar(&connectorAzureManual, "manual", false, "Run setup in Azure Cloud Shell and paste the result")
}
