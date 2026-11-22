// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

// connectorRemoveYes is the --yes opt-in: skip the confirmation prompt (and make
// the command usable with --no-input).
var connectorRemoveYes bool

// connectorRemoveCmd disconnects a cloud account. Its Long names the offered clouds, so it is
// written by applyCloudHelp.
var connectorRemoveCmd = &cobra.Command{
	Use:   "remove [provider|cloud-identity-id]",
	Short: "Disconnect a cloud account",
	Args:  cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		p := resultPrinter(cmd)
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		ref := ""
		if len(args) == 1 {
			ref = args[0]
		}
		if err := runConnectorRemove(api.NewClient(token), p, connectorRemoveOptions{
			Ref:    ref,
			Yes:    connectorRemoveYes,
			DryRun: cmdmeta.DryRunRequested(cmd),
		}); err != nil {
			fail(err)
		}
	},
}

// cloudIdentityRemover is what `connector remove` needs of the control plane.
type cloudIdentityRemover interface {
	cloudIdentityLister
	DisconnectProviderIdentity(provider, identityID string) error
}

// connectorRemoveOptions are the inputs of one `connector remove`.
type connectorRemoveOptions struct {
	// Ref is the argument: a cloud, a cloud-identity id, or empty for the picker.
	Ref string
	// Yes skips the confirmation.
	Yes bool
	// DryRun resolves the account and reports it, and disconnects nothing.
	DryRun bool
}

// removedConnection is the object of a remove result: the connection that was disconnected.
type removedConnection struct {
	Provider string `json:"provider"`
	Label    string `json:"label"`
}

// runConnectorRemove disconnects one cloud account and reports it. With no account connected and
// none named there is nothing to do, and the result says so with the action "unchanged".
func runConnectorRemove(c cloudIdentityRemover, p *Printer, opts connectorRemoveOptions) error {
	identities, err := listCloudIdentities(c)
	if err != nil {
		return err
	}
	if len(identities) == 0 && opts.Ref == "" {
		return p.Result(
			MutationResult{Kind: kindCloudIdentity, Action: ResultUnchanged, DryRun: opts.DryRun},
			func(io.Writer) { p.Note("No cloud accounts connected.") },
		)
	}

	selected, err := pickIdentity(identities, opts.Ref)
	if err != nil {
		return err
	}
	result := MutationResult{
		ID: selected.ID, Kind: kindCloudIdentity, Action: ResultDeleted, DryRun: opts.DryRun,
		Object: removedConnection{Provider: selected.Provider, Label: selected.Label},
	}
	if opts.DryRun {
		return p.Result(result, func(w io.Writer) {
			ui.MutedTo(w, fmt.Sprintf("Dry run: would disconnect %s. Nothing was changed.", selected.Label))
		})
	}

	if !confirmDestructive(
		opts.Yes,
		fmt.Sprintf("Disconnect %s?", selected.Label),
		"Projects using this account are left without a cloud account.",
	) {
		return nil
	}

	if err := c.DisconnectProviderIdentity(selected.Provider, selected.ID); err != nil {
		return fmt.Errorf("failed to disconnect %s: %w", selected.Label, err)
	}
	return p.Result(result, func(w io.Writer) {
		ui.SuccessTo(w, fmt.Sprintf("Disconnected %s", selected.Label))
	})
}

// pickIdentity resolves the connection to remove: by its id, by its cloud, or through the picker
// when nothing is named.
//
// An id is matched byte for byte before the cloud is tried. A cloud with more than one connected
// account is refused and the ids are listed: this command deletes, and choosing one of two
// accounts on the caller's behalf would disconnect an account nobody named.
func pickIdentity(identities []api.CloudIdentity, ref string) (*api.CloudIdentity, error) {
	if ref != "" {
		for i := range identities {
			if identities[i].ID == ref {
				return &identities[i], nil
			}
		}
		provider := strings.ToLower(ref)
		if !isCloudProviderSlug(provider) {
			return nil, clierr.New(clierr.CodeNotFound, fmt.Sprintf("no connected account matches %q", ref))
		}
		return connectedAccountOn(identities, provider)
	}

	// Refuse before opening a form that can never be answered. Without this the scripted
	// no-argument case died on huh's raw "could not open a new TTY" — a message about a device
	// file, for a user whose actual mistake was omitting the provider argument.
	if err := requireInteractiveForm(); err != nil {
		return nil, inputRequiredError(err,
			"no connection given: pass a provider (%s) or a cloud-identity id as the argument",
			strings.Join(connectorProviderNames(), ", "))
	}

	chosenID, err := pickConnectedIdentity("Select a connection to remove", identities)
	if err != nil {
		return nil, err
	}

	for i := range identities {
		if identities[i].ID == chosenID {
			return &identities[i], nil
		}
	}
	return nil, invalidInputError("no connection selected")
}

func init() {
	connectorCmd.AddCommand(connectorRemoveCmd)
	addYesFlag(connectorRemoveCmd, &connectorRemoveYes)
}
