// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"io"

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
	Long: `List the active organization's SSO identity providers: the protocol, the email
domain each one serves, its issuer, and whether it is enabled.`,
	Args: cobra.NoArgs,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		if err := runListCommand(cmd, ssoListView, client.ListSsoProviders); err != nil {
			fail(err)
		}
	},
}

var ssoListColumns = []string{"Provider", "Domain", "Issuer", "Enabled", "ID"}

// ssoListView is how `sso list` is drawn.
var ssoListView = listView[api.SsoProvider]{
	Spinner: "Fetching SSO providers...",
	Title:   "SSO providers",
	Empty:   "No SSO providers configured. Register one in the console.",
	Columns: ssoListColumns,
	Rows:    ssoRows,
}

// ssoRows projects SSO providers into plain table rows.
func ssoRows(providers []api.SsoProvider, outFmt string) [][]string {
	rows := make([][]string, len(providers))
	for i, p := range providers {
		rows[i] = []string{p.ProviderType, p.Domain, p.Issuer, ui.Cell(outFmt, ui.WireBool(p.Enabled), ui.YesNo(p.Enabled)), p.ID}
	}
	return rows
}

// runSsoList fetches and renders the SSO providers (non-interactive path).
func runSsoList(c apiClient, out io.Writer, format string) error {
	providers, err := c.ListSsoProviders()
	if err != nil {
		return governanceError(err)
	}
	return renderList(out, format, ssoListView, providers)
}

// ssoGetDomain is the --domain selector: name the provider by the email domain it serves instead of
// copying a provider id out of `sso list`.
var ssoGetDomain string

var ssoGetCmd = &cobra.Command{
	Use:   "get [id]",
	Short: "Show a single SSO provider",
	Long: `Show one configured SSO provider. Name it with --domain, the email domain it
serves, or pass its id; with neither on a terminal, pick from the organization's
providers. Secrets and config are never shown.`,
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		if err := runSsoGetCmd(cmd, args); err != nil {
			fail(governanceError(err))
		}
	},
}

// runSsoGetCmd is `sso get`: it resolves the provider and prints it.
func runSsoGetCmd(cmd *cobra.Command, args []string) error {
	format := outputFormat(cmd)
	token, err := getAuthToken()
	if err != nil {
		return err
	}
	client := api.NewClient(token)
	id := ""
	if len(args) > 0 {
		id = args[0]
	}
	ref, err := resolveOrgChoice(ssoPickSpec, id, ssoGetDomain, ssoChoices(client))
	if err != nil {
		return err
	}
	var provider *api.SsoProvider
	runSpinner("Fetching SSO provider...", func() { provider, err = client.GetSsoProvider(ref.ID) })
	if err != nil {
		return notFoundHint(err, ssoPickSpec.ListCmd)
	}
	if provider == nil {
		return errNoRecord("request")
	}
	return renderSsoProvider(printer.Out, format, provider)
}

// renderSsoProvider writes a single SSO provider as a KV card (table), the typed
// object (json), or Field/Value rows (csv).
func renderSsoProvider(out io.Writer, format string, p *api.SsoProvider) error {
	return ui.RenderCard(out, format, "SSO provider "+p.ID, ssoFieldRows(p, format), p)
}

// ssoFieldRows returns the key/value fields of an SSO provider.
func ssoFieldRows(p *api.SsoProvider, outFmt string) [][]string {
	return [][]string{
		{"ID", p.ID},
		{"Provider", p.ProviderType},
		{"Domain", p.Domain},
		{"Issuer", p.Issuer},
		{"Enabled", ui.Cell(outFmt, ui.WireBool(p.Enabled), ui.YesNo(p.Enabled))},
	}
}

func init() {
	ssoGetCmd.Flags().StringVar(&ssoGetDomain, "domain", "",
		"Show the provider serving this email domain, instead of naming a provider id")
	ssoCmd.AddCommand(ssoListCmd)
	ssoCmd.AddCommand(ssoGetCmd)
	rootCmd.AddCommand(ssoCmd)
}
