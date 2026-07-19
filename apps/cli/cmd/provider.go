// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var providerCmd = &cobra.Command{
	Use:     "provider",
	Aliases: []string{"providers"},
	Short:   "Inspect connected cloud provider identities",
	Long: `Show the connection status of a cloud provider identity, or re-run the
server-side health probe (auth + provisioning-capability check) against it.

Use 'alethia connector' to create or change a connection; these commands only
read and re-verify an existing one.`,
}

var providerStatusCmd = &cobra.Command{
	Use:   "status <provider>",
	Short: "Show the connection status of a cloud provider identity",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		if err := runProviderStatus(api.NewClient(token), os.Stdout, outputFormat(cmd), args[0]); err != nil {
			failf("Failed to get %s status: %v", args[0], err)
		}
	},
}

// providerStatusRows projects a ProviderStatus into field/value cells, showing
// only the identity fields relevant to the connected provider.
func providerStatusRows(s *api.ProviderStatus) [][]string {
	connected := "disconnected"
	if s.Connected {
		connected = "connected"
	}
	rows := [][]string{
		{"status", connected},
		{"identity", orDash(s.IdentityID)},
	}
	add := func(label, value string) {
		if value != "" {
			rows = append(rows, []string{label, value})
		}
	}
	add("account id", s.AccountID)
	add("role arn", s.RoleArn)
	add("project id", s.ProjectID)
	add("service account", s.ServiceAccountEmail)
	add("tenant id", s.TenantID)
	add("client id", s.ClientID)
	add("subscription id", s.SubscriptionID)
	return rows
}

// runProviderStatus fetches and renders a provider's connection status.
func runProviderStatus(c apiClient, out io.Writer, format, provider string) error {
	status, err := c.GetProviderStatus(provider)
	if err != nil {
		return err
	}
	return ui.RenderCard(out, format, "alethia · "+provider+" status", providerStatusRows(status), status)
}

var providerVerifyCmd = &cobra.Command{
	Use:   "verify <provider>",
	Short: "Re-run the server-side health probe against a connected identity",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		if err := runProviderVerify(api.NewClient(token), os.Stdout, outputFormat(cmd), args[0]); err != nil {
			failf("%v", err)
		}
	},
}

// runProviderVerify resolves the connected identity for a provider and re-runs
// the server-side verification, rendering the verdict. It returns an error (so
// the process exits non-zero) when there is nothing to verify or the probe
// reports the identity is not connected.
func runProviderVerify(c apiClient, out io.Writer, format, provider string) error {
	status, err := c.GetProviderStatus(provider)
	if err != nil {
		return fmt.Errorf("failed to get %s status: %w", provider, err)
	}
	if !status.Connected || status.IdentityID == "" {
		return fmt.Errorf("no connected %s identity to verify — run `alethia connector` first", provider)
	}

	result, err := c.VerifyProviderIdentity(provider, status.IdentityID)
	if err != nil {
		return fmt.Errorf("failed to verify %s connection: %w", provider, err)
	}

	rows := [][]string{
		{"identity", result.IdentityID},
		{"status", result.Status},
		{"verified", fmt.Sprintf("%t", result.Verified)},
	}
	if len(result.MissingPermissions) > 0 {
		rows = append(rows, []string{"missing permissions", strings.Join(result.MissingPermissions, ", ")})
	}
	if result.Error != "" {
		rows = append(rows, []string{"error", result.Error})
	}
	if err := ui.RenderCard(out, format, "alethia · "+provider+" verify", rows, result); err != nil {
		return err
	}

	if !result.Verified {
		return fmt.Errorf("%s connection failed verification (%s)", provider, result.Status)
	}
	if result.Status == "degraded" {
		ui.Warning("Connected, but missing some provisioning permissions.")
	}
	return nil
}

func init() {
	providerCmd.AddCommand(providerStatusCmd)
	providerCmd.AddCommand(providerVerifyCmd)
	rootCmd.AddCommand(providerCmd)
}
