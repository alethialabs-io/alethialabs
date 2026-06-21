// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"os"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/charmbracelet/huh"
	"github.com/charmbracelet/huh/spinner"
	"github.com/spf13/cobra"
)

var deleteZoneCmd = &cobra.Command{
	Use:   "delete [id]",
	Short: "Delete a zone",
	Args:  cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		var id string
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}

		if len(args) == 0 {
			var zones []api.ZoneWithSpecs

			spinner.New().
				Title("Fetching zones...").
				Action(func() {
					zones, err = api.NewClient(token).GetZones()
				}).Run()

			if err != nil {
				failf("Error fetching zones: %v", err)
			}

			if len(zones) == 0 {
				fmt.Println("No zones found to delete.")
				os.Exit(0)
			}

			options := make([]huh.Option[string], len(zones))
			for i, v := range zones {
				options[i] = huh.NewOption(fmt.Sprintf("%s (%s)", v.Name, v.ID), v.ID)
			}

			err = huh.NewForm(
				huh.NewGroup(
					huh.NewSelect[string]().
						Title("Select Zone").
						Description("Which zone to delete").
						Options(options...).
						Value(&id),
				),
			).Run()

			if err != nil {
				if err == huh.ErrUserAborted {
					fmt.Println("Aborted.")
					os.Exit(0)
				}
				failf("Error: %v", err)
			}
		} else {
			id = args[0]
		}

		if !confirm(
			fmt.Sprintf("Are you sure you want to delete zone %s?", id),
			"This action cannot be undone.",
		) {
			return
		}

		spinner.New().
			Title(fmt.Sprintf("Deleting zone %s...", id)).
			Action(func() {
				err = api.NewClient(token).DeleteZone(id)
			}).Run()

		if err != nil {
			failf("Error deleting zone: %v", err)
		}

		ui.Success(fmt.Sprintf("Deleted zone (ID: %s)", id))
	},
}

func init() {
	zoneCmd.AddCommand(deleteZoneCmd)
}
