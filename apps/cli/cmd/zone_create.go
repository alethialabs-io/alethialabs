// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/charmbracelet/huh"
	"github.com/charmbracelet/huh/spinner"
	"github.com/spf13/cobra"
)

var createZoneCmd = &cobra.Command{
	Use:   "create [name]",
	Short: "Create a new zone (workspace)",
	Args:  cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		var name, desc string

		if len(args) == 0 {
			err := huh.NewForm(
				huh.NewGroup(
					huh.NewInput().
						Title("Zone Name").
						Description("Enter a unique name for your workspace").
						Value(&name).
						Validate(func(str string) error {
							if strings.TrimSpace(str) == "" {
								return errors.New("name cannot be empty")
							}
							return nil
						}),
					huh.NewInput().
						Title("Description (optional)").
						Description("A brief description of this workspace").
						Value(&desc),
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
			name = args[0]
			desc, _ = cmd.Flags().GetString("description")
		}

		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}

		var zone *types.Zone

		spinner.New().
			Title(fmt.Sprintf("Creating zone '%s'...", name)).
			Action(func() {
				zone, err = api.NewClient(token).CreateZone(name, desc)
			}).Run()

		if err != nil {
			failf("Error creating zone: %v", err)
		}

		ui.Success(fmt.Sprintf("Created zone '%s' (ID: %s)", zone.Name, zone.ID))
	},
}

func init() {
	createZoneCmd.Flags().StringP("description", "d", "", "Description for the zone")
	zoneCmd.AddCommand(createZoneCmd)
}
