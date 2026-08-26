// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

// `alethia token` — manage the service-account tokens that let `alethia` run WITHOUT a browser.
//
// The device flow (`alethia login`) is the right experience at a terminal and an impossible one in
// a pipeline: it opens a browser and waits for a human. `--no-input` does not help — it suppresses
// prompts, it does not supply a credential. These commands mint the credential that does, and
// $ALETHIA_TOKEN is how a pipeline presents it.
var tokenCmd = &cobra.Command{
	Use:   "token",
	Short: "Manage service-account tokens for non-interactive use (CI, cron, pipelines)",
	Long: "Service-account tokens let `alethia` authenticate without a browser.\n\n" +
		"Mint one with `alethia token create`, put it in your pipeline's secret store, and set\n" +
		"$ALETHIA_TOKEN. The token acts as you, inside the organization it was minted for, and\n" +
		"can be revoked at any time — it stops working on the next request.",
}

var (
	tokenCreateName    string
	tokenCreateExpires int
)

var tokenListCmd = &cobra.Command{
	Use:   "list",
	Short: "List this organization's service-account tokens",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		var tokens []api.ServiceToken
		if interactiveTable(cmd) {
			ui.RunSpinner("Fetching tokens...", func() { tokens, err = client.ListServiceTokens() })
		} else {
			tokens, err = client.ListServiceTokens()
		}
		if err != nil {
			failf("Failed to list tokens: %v", err)
		}
		if len(tokens) == 0 && interactiveTable(cmd) {
			ui.Muted("No service tokens. Create one with `alethia token create --name ci`.")
			return
		}
		if err := ui.Render(os.Stdout, outputFormat(cmd), ui.TableSpec{
			Columns: tokenListColumns,
			Rows:    tokenRows(tokens),
		}, tokens); err != nil {
			failf("Failed to render tokens: %v", err)
		}
	},
}

var tokenListColumns = []string{"ID", "Name", "Prefix", "Created", "Expires", "Last used", "Status"}

func tokenRows(tokens []api.ServiceToken) [][]string {
	rows := make([][]string, 0, len(tokens))
	for _, t := range tokens {
		rows = append(rows, []string{
			t.ID,
			t.Name,
			t.TokenPrefix,
			stampOrDash(&t.CreatedAt),
			stampOrNever(t.ExpiresAt),
			stampOrNever(t.LastUsedAt),
			tokenStatus(t),
		})
	}
	return rows
}

// stampOrDash renders a timestamp, or "—" when absent.
func stampOrDash(v *string) string {
	if v == nil || strings.TrimSpace(*v) == "" {
		return "—"
	}
	if t, err := time.Parse(time.RFC3339, *v); err == nil {
		return t.UTC().Format("2006-01-02 15:04")
	}
	return *v
}

// stampOrNever renders a timestamp, or "never" when absent.
//
// "never" rather than "—" is the point for `last_used_at`: a token that has NEVER been used is the
// single most actionable row in the list. It is the one somebody minted, pasted somewhere wrong, and
// forgot — and a dash reads as missing data rather than as a finding.
func stampOrNever(v *string) string {
	if v == nil || strings.TrimSpace(*v) == "" {
		return "never"
	}
	return stampOrDash(v)
}

// tokenStatus collapses the three timestamps into the one word a reader wants.
//
// REVOKED WINS OVER EXPIRED. Both are inactive, but which came first is the fact an incident needs,
// and a token revoked in response to a leak must never be reported as having merely aged out.
func tokenStatus(t api.ServiceToken) string {
	if t.RevokedAt != nil && strings.TrimSpace(*t.RevokedAt) != "" {
		return "revoked"
	}
	if t.ExpiresAt != nil && strings.TrimSpace(*t.ExpiresAt) != "" {
		if exp, err := time.Parse(time.RFC3339, *t.ExpiresAt); err == nil && exp.Before(time.Now()) {
			return "expired"
		}
	}
	return "active"
}

var tokenCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Mint a service-account token (shown ONCE)",
	Run: func(cmd *cobra.Command, args []string) {
		name := strings.TrimSpace(tokenCreateName)
		if name == "" {
			failf("--name is required: a list of tokens should be a list of PURPOSES, not of prefixes")
		}
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		created, err := client.CreateServiceToken(name, tokenCreateExpires)
		if err != nil {
			failf("Failed to create token: %v", err)
		}

		// The value goes to STDOUT and everything else to stderr, so `alethia token create ... |
		// gh secret set` does the right thing and a user never has to select the token out of a
		// decorated block by eye. In table mode the warning is loud; in json/csv the caller is a
		// program and the plain value is what it needs.
		if interactiveTable(cmd) {
			fmt.Fprintln(os.Stderr)
			ui.Muted(created.Warning)
			fmt.Fprintf(os.Stderr, "  id      %s\n  name    %s\n  prefix  %s\n  expires %s\n\n",
				created.ID, created.Name, created.TokenPrefix, stampOrNever(created.ExpiresAt))
			fmt.Println(created.Token)
			fmt.Fprintln(os.Stderr)
			ui.Muted("Use it with:  export ALETHIA_TOKEN=…   (or --token)")
			return
		}
		if err := ui.Render(os.Stdout, outputFormat(cmd), ui.TableSpec{
			Columns: []string{"ID", "Name", "Prefix", "Token"},
			Rows:    [][]string{{created.ID, created.Name, created.TokenPrefix, created.Token}},
		}, created); err != nil {
			failf("Failed to render token: %v", err)
		}
	},
}

var tokenRevokeCmd = &cobra.Command{
	Use:   "revoke <id>",
	Short: "Revoke a service-account token",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		if err := client.RevokeServiceToken(args[0]); err != nil {
			failf("Failed to revoke token: %v", err)
		}
		ui.Muted(fmt.Sprintf("Revoked %s — it stops working on its next request.", args[0]))
	},
}

func init() {
	tokenCreateCmd.Flags().StringVar(&tokenCreateName, "name", "", "What this token is for (required)")
	tokenCreateCmd.Flags().IntVar(&tokenCreateExpires, "expires-in-days", 0,
		"Days until the token expires. 0 (the default) never expires — a deliberate choice, not an oversight.")
	tokenCmd.AddCommand(tokenListCmd, tokenCreateCmd, tokenRevokeCmd)
	rootCmd.AddCommand(tokenCmd)
}
