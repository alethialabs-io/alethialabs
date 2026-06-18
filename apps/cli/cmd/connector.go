// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/charmbracelet/huh/spinner"
	"github.com/spf13/cobra"
)

const (
	// connectorBaseURL hosts the public copies of the setup artifacts used by
	// the guided-manual fallbacks.
	connectorBaseURL   = "https://alethia-onboarding-templates.s3.eu-west-1.amazonaws.com"
	gcpCloudShellURL   = "https://shell.cloud.google.com/cloudshell/open?shellonly=true&show=terminal"
	azureCloudShellURL = "https://shell.azure.com"
	alethiaAwsAccount  = "787587782604"
)

var connectorCmd = &cobra.Command{
	Use:   "connector",
	Short: "Connect cloud provider accounts (AWS, GCP, Azure)",
	Long: `Manage cloud provider connections.

Connecting a cloud account lets Alethia provision infrastructure into it using
short-lived, keyless credentials: AWS cross-account roles, GCP Workload Identity
Federation, and Azure federated identity. No long-lived secrets are stored.`,
}

func init() {
	rootCmd.AddCommand(connectorCmd)
}

// initProviderIdentity creates (or reuses) the user's pending identity for a
// provider, with a spinner.
func initProviderIdentity(apiClient *api.Client, provider string) (*api.InitIdentityResponse, error) {
	var resp *api.InitIdentityResponse
	var err error
	spinner.New().
		Title("Initializing connection...").
		Action(func() {
			resp, err = apiClient.InitProviderIdentity(provider)
		}).Run()
	return resp, err
}

// finalizeConnection submits the captured credentials, waits for the
// CONNECTION_TEST job, and marks the identity verified once it passes.
func finalizeConnection(
	apiClient *api.Client,
	provider, identityID string,
	creds map[string]interface{},
) error {
	var resp *api.ConnectIdentityResponse
	var err error
	spinner.New().
		Title("Submitting credentials & queuing connection test...").
		Action(func() {
			resp, err = apiClient.ConnectProviderIdentity(provider, identityID, creds)
		}).Run()
	if err != nil {
		return err
	}

	ui.JobQueued("CONNECTION_TEST", resp.JobID)
	if err := waitForJob(apiClient, resp.JobID); err != nil {
		return err
	}

	if err := apiClient.VerifyProviderIdentity(provider, identityID, resp.JobID); err != nil {
		return fmt.Errorf("connection test passed but verification failed: %w", err)
	}
	return nil
}
