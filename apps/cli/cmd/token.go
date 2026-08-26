// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"errors"
	"fmt"
	"io"
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
		if err := runTokenList(api.NewClient(token), os.Stdout, outputFormat(cmd)); err != nil {
			failf("Failed to list tokens: %v", err)
		}
	},
}

// runTokenList is the testable half — the same client/writer/format shape runOrgList uses, so the
// cobra Run above stays thin glue and the behaviour is driven directly.
func runTokenList(c apiClient, out io.Writer, format string) error {
	tokens, err := c.ListServiceTokens()
	if err != nil {
		return err
	}
	if len(tokens) == 0 && format == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render("No service tokens. Create one with `alethia token create --name ci`."))
		return nil
	}
	return ui.Render(out, format, ui.TableSpec{Columns: tokenListColumns, Rows: tokenRows(tokens)}, tokens)
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
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		if err := runTokenCreate(api.NewClient(token), os.Stdout, os.Stderr, outputFormat(cmd), tokenCreateName, tokenCreateExpires); err != nil {
			failf("%v", err)
		}
	},
}

// runTokenCreate mints one and surfaces it exactly once.
//
// THE VALUE GOES TO `out`, EVERYTHING ELSE TO `errOut`. That split is the feature: it makes
// `alethia token create --name ci | gh secret set ALETHIA_TOKEN` do the right thing, so nobody has
// to select a credential out of a decorated block by eye.
func runTokenCreate(c apiClient, out, errOut io.Writer, format, name string, expiresInDays int) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return errors.New("--name is required: a list of tokens should be a list of PURPOSES, not of prefixes")
	}
	created, err := c.CreateServiceToken(name, expiresInDays)
	if err != nil {
		return fmt.Errorf("failed to create token: %w", err)
	}
	if format != ui.FormatTable {
		// The caller is a program; the plain value is what it needs.
		return ui.Render(out, format, ui.TableSpec{
			Columns: []string{"ID", "Name", "Prefix", "Token"},
			Rows:    [][]string{{created.ID, created.Name, created.TokenPrefix, created.Token}},
		}, created)
	}
	fmt.Fprintln(errOut)
	fmt.Fprintln(errOut, ui.MutedStyle.Render(created.Warning))
	fmt.Fprintf(errOut, "  id      %s\n  name    %s\n  prefix  %s\n  expires %s\n\n",
		created.ID, created.Name, created.TokenPrefix, stampOrNever(created.ExpiresAt))
	fmt.Fprintln(out, created.Token)
	fmt.Fprintln(errOut)
	fmt.Fprintln(errOut, ui.MutedStyle.Render("Use it with:  export ALETHIA_TOKEN=…   (or --token)"))
	return nil
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
		if err := runTokenRevoke(api.NewClient(token), os.Stdout, args[0]); err != nil {
			failf("Failed to revoke token: %v", err)
		}
	},
}

// runTokenRevoke revokes one by id. It takes effect on the token's very next request, because
// `resolveServiceToken` filters on `revoked_at` inside the lookup query itself.
func runTokenRevoke(c apiClient, out io.Writer, id string) error {
	if err := c.RevokeServiceToken(id); err != nil {
		return err
	}
	fmt.Fprintln(out, ui.MutedStyle.Render(fmt.Sprintf("Revoked %s — it stops working on its next request.", id)))
	return nil
}

func init() {
	tokenCreateCmd.Flags().StringVar(&tokenCreateName, "name", "", "What this token is for (required)")
	tokenCreateCmd.Flags().IntVar(&tokenCreateExpires, "expires-in-days", 0,
		"Days until the token expires. 0 (the default) never expires — a deliberate choice, not an oversight.")
	tokenCmd.AddCommand(tokenListCmd, tokenCreateCmd, tokenRevokeCmd)
	rootCmd.AddCommand(tokenCmd)
}
