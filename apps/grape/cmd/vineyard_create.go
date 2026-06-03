package cmd

import (
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/bobikenobi12/bb-thesis-2026/packages/grape-core/types"
	"github.com/charmbracelet/huh"
	"github.com/charmbracelet/huh/spinner"
	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/pkg/utils/ui"
	"github.com/imroc/req/v3"
	"github.com/spf13/cobra"
)

var createVineyardCmd = &cobra.Command{
	Use:   "create [name]",
	Short: "Create a new vineyard (workspace)",
	Args:  cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		var name, desc string

		if len(args) == 0 {
			err := huh.NewForm(
				huh.NewGroup(
					huh.NewInput().
						Title("Vineyard Name").
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
				fmt.Printf("Error: %v\n", err)
				os.Exit(1)
			}
		} else {
			name = args[0]
			desc, _ = cmd.Flags().GetString("description")
		}

		token, err := getAuthToken()
		if err != nil {
			fmt.Println(err)
			os.Exit(1)
		}

		webOrigin := os.Getenv("GRAPE_WEB_ORIGIN")
		if webOrigin == "" {
			webOrigin = "https://adp.prod.itgix.eu"
		}
		createURL := fmt.Sprintf("%s/api/cli/vineyards", webOrigin)

		payload := map[string]string{
			"name": name,
		}
		if desc != "" {
			payload["description"] = desc
		}

		var result struct {
			Vineyard types.Vineyard `json:"vineyard"`
		}
		var errMsg struct {
			Error string `json:"error"`
		}

		var resp *req.Response
		client := req.C()

		action := func() {
			resp, err = client.R().
				SetBearerAuthToken(token).
				SetBody(payload).
				SetSuccessResult(&result).
				SetErrorResult(&errMsg).
				Post(createURL)
		}

		err = spinner.New().
			Title(fmt.Sprintf("Creating vineyard '%s'...", name)).
			Action(action).
			Run()

		if err != nil {
			fmt.Printf("Error connecting to server: %v\n", err)
			os.Exit(1)
		}

		if resp.IsErrorState() {
			fmt.Printf("Error creating vineyard (HTTP %d): %s\n", resp.StatusCode, errMsg.Error)
			os.Exit(1)
		}

		ui.Success(fmt.Sprintf("Created vineyard '%s' (ID: %s)", result.Vineyard.Name, result.Vineyard.ID))
	},
}

func init() {
	createVineyardCmd.Flags().StringP("description", "d", "", "Description for the vineyard")
	vineyardCmd.AddCommand(createVineyardCmd)
}
