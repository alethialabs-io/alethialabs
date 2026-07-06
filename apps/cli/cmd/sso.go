// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"os"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var ssoCmd = &cobra.Command{
	Use:   "sso",
	Short: "View configured SSO providers",
	Long: `Inspect the active organization's configured SSO identity providers (OIDC and
SAML). Read-only — registering a provider is done in the console (Better Auth's SSO
plugin). Secrets and config are never shown.`,
}

var ssoListCmd = &cobra.Command{
	Use:   "list",
	Short: "List configured SSO providers",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		if interactiveTable(cmd) {
			var providers []api.SsoProvider
			ui.RunSpinner("Fetching SSO providers...", func() { providers, err = client.ListSsoProviders() })
			if err != nil {
				failf("Failed to list SSO providers: %v", err)
			}
			if len(providers) == 0 {
				ui.Muted("No SSO providers configured.")
				return
			}
			_ = ui.ShowTable(ssoListColumns, ssoRows(providers), "SSO providers")
			return
		}
		if err := runSsoList(client, os.Stdout, outputFormat(cmd)); err != nil {
			failf("Failed to list SSO providers: %v", err)
		}
	},
}

var ssoListColumns = []string{"Provider", "Domain", "Issuer", "Enabled", "ID"}

// ssoRows projects SSO providers into plain table rows.
func ssoRows(providers []api.SsoProvider) [][]string {
	rows := make([][]string, len(providers))
	for i, p := range providers {
		rows[i] = []string{p.ProviderType, p.Domain, p.Issuer, yesNo(p.Enabled), p.ID}
	}
	return rows
}

// runSsoList fetches and renders the SSO providers (non-interactive path).
func runSsoList(c apiClient, out io.Writer, format string) error {
	providers, err := c.ListSsoProviders()
	if err != nil {
		return err
	}
	if len(providers) == 0 && format == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render("No SSO providers configured."))
		return nil
	}
	return ui.Render(out, format, ui.TableSpec{
		Columns: ssoListColumns,
		Rows:    ssoRows(providers),
	}, providers)
}

var ssoGetCmd = &cobra.Command{
	Use:   "get <id>",
	Short: "Show a single SSO provider",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		var provider *api.SsoProvider
		ui.RunSpinner("Fetching SSO provider...", func() { provider, err = client.GetSsoProvider(args[0]) })
		if err != nil {
			failf("Failed to get SSO provider: %v", err)
		}
		if err := renderSsoProvider(os.Stdout, outputFormat(cmd), provider); err != nil {
			fail(err)
		}
	},
}

// renderSsoProvider writes a single SSO provider as a KV card (table), the typed
// object (json), or Field/Value rows (csv).
func renderSsoProvider(out io.Writer, format string, p *api.SsoProvider) error {
	return ui.RenderCard(out, format, "SSO provider "+p.ID, ssoFieldRows(p), p)
}

// ssoFieldRows returns the key/value fields of an SSO provider.
func ssoFieldRows(p *api.SsoProvider) [][]string {
	return [][]string{
		{"ID", p.ID},
		{"Provider", p.ProviderType},
		{"Domain", p.Domain},
		{"Issuer", p.Issuer},
		{"Enabled", yesNo(p.Enabled)},
	}
}

func init() {
	ssoCmd.AddCommand(ssoListCmd)
	ssoCmd.AddCommand(ssoGetCmd)
	rootCmd.AddCommand(ssoCmd)
}
