// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"os"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/charmbracelet/huh"
	"github.com/charmbracelet/huh/spinner"
	"github.com/spf13/cobra"
)

var connectorRemoveYes bool

var connectorRemoveCmd = &cobra.Command{
	Use:   "remove [provider]",
	Short: "Disconnect a cloud account",
	Long: `Disconnect a cloud account, resetting it to a pending state and orphaning
any specs that referenced it. Pass a provider (aws, gcp, azure) to skip the
picker.`,
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fmt.Println(err)
			os.Exit(1)
		}
		apiClient := api.NewClient(token)

		var identities []api.CloudIdentity
		spinner.New().
			Title("Fetching cloud connections...").
			Action(func() {
				identities, err = apiClient.GetCloudIdentities()
			}).Run()
		if err != nil {
			ui.Error(err.Error())
			os.Exit(1)
		}
		if len(identities) == 0 {
			ui.Muted("No cloud accounts connected.")
			return
		}

		selected, err := pickIdentity(identities, args)
		if err != nil {
			ui.Error(err.Error())
			os.Exit(1)
		}

		if !connectorRemoveYes {
			confirm := false
			if err := huh.NewForm(huh.NewGroup(
				huh.NewConfirm().
					Title(fmt.Sprintf("Disconnect %s?", selected.Label)).
					Description("Specs using this account will be orphaned.").
					Value(&confirm),
			)).Run(); err != nil {
				fmt.Println(err)
				os.Exit(1)
			}
			if !confirm {
				ui.Muted("Cancelled.")
				return
			}
		}

		if err := apiClient.DisconnectProviderIdentity(selected.Provider, selected.ID); err != nil {
			ui.Error(err.Error())
			os.Exit(1)
		}
		ui.Success(fmt.Sprintf("Disconnected %s", selected.Label))
	},
}

// pickIdentity resolves the identity to remove from a provider argument, or via
// an interactive picker when none is given.
func pickIdentity(identities []api.CloudIdentity, args []string) (*api.CloudIdentity, error) {
	if len(args) == 1 {
		provider := strings.ToLower(args[0])
		for i := range identities {
			if identities[i].Provider == provider {
				return &identities[i], nil
			}
		}
		return nil, fmt.Errorf("no connected %s account found", provider)
	}

	options := make([]huh.Option[string], len(identities))
	for i, id := range identities {
		options[i] = huh.NewOption(
			fmt.Sprintf("%s — %s", strings.ToUpper(id.Provider), id.Label),
			id.ID,
		)
	}

	var chosenID string
	if err := huh.NewForm(huh.NewGroup(
		huh.NewSelect[string]().
			Title("Select a connection to remove").
			Options(options...).
			Value(&chosenID),
	)).Run(); err != nil {
		return nil, err
	}

	for i := range identities {
		if identities[i].ID == chosenID {
			return &identities[i], nil
		}
	}
	return nil, fmt.Errorf("no connection selected")
}

func init() {
	connectorCmd.AddCommand(connectorRemoveCmd)
	connectorRemoveCmd.Flags().BoolVarP(&connectorRemoveYes, "yes", "y", false, "Skip the confirmation prompt")
}
