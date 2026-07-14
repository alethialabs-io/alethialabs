// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

const (
	// connectorBaseURL hosts the public copies of the setup artifacts used by
	// the guided-manual fallbacks (provisioned by infra/connector-assets).
	connectorBaseURL     = "https://alethia-connector-assets.s3.eu-west-1.amazonaws.com"
	gcpCloudShellURL     = "https://shell.cloud.google.com/cloudshell/open?shellonly=true&show=terminal"
	azureCloudShellURL   = "https://shell.azure.com"
	alibabaCloudShellURL = "https://shell.aliyun.com"
	awsCloudShellURL     = "https://console.aws.amazon.com/cloudshell/home"
)

var connectorCmd = &cobra.Command{
	Use:   "connector",
	Short: "Connect cloud provider accounts (AWS, GCP, Azure, Alibaba)",
	Long: `Manage cloud provider connections.

Connecting a cloud account lets Alethia provision infrastructure into it using
short-lived, keyless credentials: AWS cross-account roles, GCP Workload Identity
Federation, Azure federated identity, and Alibaba RAM AssumeRoleWithOIDC. No
long-lived secrets are stored.`,
}

func init() {
	rootCmd.AddCommand(connectorCmd)
}

// initProviderIdentity creates (or reuses) the user's pending identity for a
// provider, with a spinner.
func initProviderIdentity(apiClient *api.Client, provider string) (*api.InitIdentityResponse, error) {
	var resp *api.InitIdentityResponse
	var err error
	ui.RunSpinner("Initializing connection...", func() {
		resp, err = apiClient.InitProviderIdentity(provider)
	})
	return resp, err
}

// finalizeConnection submits the captured credentials and reports the verdict. The
// server verifies the identity INLINE (a synchronous health probe) and returns the
// result directly — there is no CONNECTION_TEST job to wait for.
func finalizeConnection(
	apiClient *api.Client,
	provider, identityID string,
	creds map[string]interface{},
) error {
	var resp *api.ConnectIdentityResponse
	var err error
	ui.RunSpinner("Submitting credentials & running connection test...", func() {
		resp, err = apiClient.ConnectProviderIdentity(provider, identityID, creds)
	})
	if err != nil {
		return err
	}

	if !resp.Verified {
		if resp.Error != "" {
			return fmt.Errorf("connection test failed (%s): %s", resp.Status, resp.Error)
		}
		return fmt.Errorf("connection test failed (%s)", resp.Status)
	}

	if resp.Status == "degraded" && len(resp.MissingPermissions) > 0 {
		ui.Warning(fmt.Sprintf(
			"Connected, but missing some provisioning permissions: %s",
			strings.Join(resp.MissingPermissions, ", "),
		))
		return nil
	}
	ui.Success("Connection verified")
	return nil
}
