// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var providerCmd = &cobra.Command{
	Use:     "provider",
	Aliases: []string{"providers"},
	Short:   "Inspect and re-verify connected cloud accounts",
	Long: `Show the connection status of a cloud account, or run the control plane's health
probe against it again.

These commands read and re-verify a connection that exists. Use 'alethia connector'
to create or remove one.`,
}

// providerStatusCmd shows one cloud's connection. Its Long names the offered clouds, so it is
// written by applyCloudHelp.
var providerStatusCmd = &cobra.Command{
	Use:   "status [provider]",
	Short: "Show whether a cloud is connected and the identity Alethia uses on it",
	Args:  cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		p := resultPrinter(cmd)
		if err := checkProviderArg(args); err != nil {
			fail(err)
		}
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		provider, err := resolveProviderRef(client, args)
		if err != nil {
			fail(err)
		}
		if err := runProviderStatus(client, p, provider); err != nil {
			fail(err)
		}
	},
}

// resolveProviderRef turns the optional `[provider]` argument into a provider slug, showing a
// picker over the CONNECTED accounts when it is omitted.
//
// The picker lists what you have connected rather than every provider Alethia supports: these
// two commands read and re-probe an existing connection, so offering a provider with no
// identity behind it can only ever produce "no connected X identity".
func resolveProviderRef(lister cloudIdentityLister, args []string) (string, error) {
	if err := checkProviderArg(args); err != nil {
		return "", err
	}
	if len(args) == 1 {
		return providerSlug(args[0]), nil
	}

	identities, err := listCloudIdentities(lister)
	if err != nil {
		return "", err
	}
	if len(identities) == 0 {
		return "", noCloudAccountsError()
	}

	chosenID, err := pickConnectedIdentity("Select a cloud account", identities)
	if err != nil {
		return "", err
	}
	for _, id := range identities {
		if id.ID == chosenID {
			return id.Provider, nil
		}
	}
	return "", invalidInputError("no cloud account selected")
}

// providerSlug returns the `[provider]` argument in the form the control plane keys clouds by.
func providerSlug(arg string) string {
	return strings.ToLower(strings.TrimSpace(arg))
}

// checkProviderArg refuses what the command line alone shows to be wrong: an argument that is not
// a cloud, and no argument where nothing can show the picker. It asks nothing of the control
// plane, so the commands call it before they sign in and the refusal is made before any request.
func checkProviderArg(args []string) error {
	if len(args) == 1 {
		if !isCloudProviderSlug(providerSlug(args[0])) {
			return clierr.New(clierr.CodeInvalidUsage, fmt.Sprintf(
				"%q is not a cloud: pass one of %s", args[0], strings.Join(connectorProviderNames(), ", ")))
		}
		return nil
	}
	if err := requireInteractiveForm(); err != nil {
		return inputRequiredError(err, "no provider given: pass one (%s) as the argument",
			strings.Join(connectorProviderNames(), ", "))
	}
	return nil
}

// providerStatusRows projects a ProviderStatus into field/value cells, showing
// only the identity fields relevant to the connected provider.
func providerStatusRows(s *api.ProviderStatus, outFmt string) [][]string {
	connected := "disconnected"
	if s.Connected {
		connected = "connected"
	}
	rows := [][]string{
		{"status", connected},
		{"identity", ui.Cell(outFmt, s.IdentityID, ui.OrDash(s.IdentityID))},
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

// runProviderStatus fetches a provider's connection status and writes it on the Printer's stdout.
//
// A cloud this build does not offer is still answered for when an account is connected on it. With
// none, the answer is the refusal: there is nothing to show and nothing new may be connected.
func runProviderStatus(c apiClient, p *Printer, provider string) error {
	status, err := c.GetProviderStatus(provider)
	if err != nil {
		return fmt.Errorf("failed to get %s status: %w", provider, err)
	}
	if !status.Connected {
		if err := requireCloudOffered(provider); err != nil {
			return err
		}
	}
	return ui.RenderCard(p.Out, p.Format, "alethia · "+provider+" status", providerStatusRows(status, p.Format), status)
}

// providerVerifyCmd re-runs the health probe. Its Long names the offered clouds, so it is written
// by applyCloudHelp.
var providerVerifyCmd = &cobra.Command{
	Use:   "verify [provider]",
	Short: "Run the health probe against a connected cloud account again",
	Args:  cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		p := resultPrinter(cmd)
		if err := checkProviderArg(args); err != nil {
			fail(err)
		}
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		provider, err := resolveProviderRef(client, args)
		if err != nil {
			fail(err)
		}
		if err := runProviderVerify(client, p, provider); err != nil {
			fail(err)
		}
	},
}

// runProviderVerify resolves the connected identity for a provider, re-runs the server-side
// verification and reports the verdict as a mutation result: the probe's outcome is recorded on
// the connection.
//
// A probe that fails is an error of the operation-failed class and nothing is written on stdout.
// The error carries the status and the reason the control plane gave.
func runProviderVerify(c apiClient, p *Printer, provider string) error {
	status, err := c.GetProviderStatus(provider)
	if err != nil {
		return fmt.Errorf("failed to get %s status: %w", provider, err)
	}
	if !status.Connected || status.IdentityID == "" {
		if err := requireCloudOffered(provider); err != nil {
			return err
		}
		notFound := clierr.New(clierr.CodeNotFound, fmt.Sprintf("no connected %s identity to verify", provider))
		if connectorHasProvider(provider) {
			notFound.Hint = fmt.Sprintf("Connect one with `alethia connector %s`.", provider)
		}
		return notFound
	}

	result, err := c.VerifyProviderIdentity(provider, status.IdentityID)
	if err != nil {
		return fmt.Errorf("failed to verify %s connection: %w", provider, err)
	}
	if !result.Verified {
		message := fmt.Sprintf("%s connection failed verification (%s)", provider, result.Status)
		if result.Error != "" {
			message += ": " + result.Error
		}
		failed := clierr.New(clierr.CodeOperationFailed, message)
		failed.Hint = "Check the access on the cloud side, then run the command again."
		return failed
	}

	missing := result.MissingPermissions
	if missing == nil {
		missing = []string{}
	}
	if result.Status == "degraded" {
		p.Warn("Connected, but missing some provisioning permissions.")
	}
	return p.Result(
		MutationResult{
			ID: result.IdentityID, Kind: kindCloudIdentity, Action: ResultUpdated,
			Object: connectionRecord{
				Provider:           provider,
				Status:             result.Status,
				Verified:           result.Verified,
				MissingPermissions: missing,
			},
		},
		func(w io.Writer) {
			rows := [][]string{
				{"identity", result.IdentityID},
				{"status", result.Status},
				{"verified", fmt.Sprintf("%t", result.Verified)},
			}
			if len(missing) > 0 {
				rows = append(rows, []string{"missing permissions", strings.Join(missing, ", ")})
			}
			_ = ui.RenderCard(w, ui.FormatTable, "alethia · "+provider+" verify", rows, result)
		},
	)
}

func init() {
	providerCmd.AddCommand(providerStatusCmd)
	providerCmd.AddCommand(providerVerifyCmd)
	rootCmd.AddCommand(providerCmd)
}
