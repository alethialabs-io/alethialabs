// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"os"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/charmbracelet/huh"
	"github.com/charmbracelet/huh/spinner"
	"github.com/imroc/req/v3"
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
			fmt.Println(err)
			os.Exit(1)
		}

		webOrigin := WebOrigin()

		if len(args) == 0 {
			var result struct {
				Zones []types.Zone `json:"zones"`
			}
			var errMsg struct {
				Error string `json:"error"`
			}

			client := req.C()
			listURL := fmt.Sprintf("%s/api/cli/zones", webOrigin)

			var resp *req.Response
			action := func() {
				resp, err = client.R().
					SetBearerAuthToken(token).
					SetSuccessResult(&result).
					SetErrorResult(&errMsg).
					Get(listURL)
			}

			err = spinner.New().
				Title("Fetching zones...").
				Action(action).
				Run()

			if err != nil {
				fmt.Printf("Error connecting to server: %v\n", err)
				os.Exit(1)
			}
			if resp.IsErrorState() {
				fmt.Printf("Error fetching zones (HTTP %d): %s\n", resp.StatusCode, errMsg.Error)
				os.Exit(1)
			}

			if len(result.Zones) == 0 {
				fmt.Println("No zones found to delete.")
				os.Exit(0)
			}

			options := make([]huh.Option[string], len(result.Zones))
			for i, v := range result.Zones {
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
				fmt.Printf("Error: %v\n", err)
				os.Exit(1)
			}
		} else {
			id = args[0]
		}

		var confirm bool
		err = huh.NewForm(
			huh.NewGroup(
				huh.NewConfirm().
					Title(fmt.Sprintf("Are you sure you want to delete zone %s?", id)).
					Description("This action cannot be undone.").
					Value(&confirm),
			),
		).Run()

		if err != nil || !confirm {
			fmt.Println("Aborted.")
			os.Exit(0)
		}

		deleteURL := fmt.Sprintf("%s/api/cli/zones/%s", webOrigin, id)

		var errMsg struct {
			Error string `json:"error"`
		}

		var resp *req.Response
		client := req.C()

		deleteAction := func() {
			resp, err = client.R().
				SetBearerAuthToken(token).
				SetErrorResult(&errMsg).
				Delete(deleteURL)
		}

		err = spinner.New().
			Title(fmt.Sprintf("Deleting zone %s...", id)).
			Action(deleteAction).
			Run()

		if err != nil {
			fmt.Printf("Error connecting to server: %v\n", err)
			os.Exit(1)
		}

		if resp.IsErrorState() {
			fmt.Printf("Error deleting zone (HTTP %d): %s\n", resp.StatusCode, errMsg.Error)
			os.Exit(1)
		}

		ui.Success(fmt.Sprintf("Deleted zone (ID: %s)", id))
	},
}

func init() {
	zoneCmd.AddCommand(deleteZoneCmd)
}
