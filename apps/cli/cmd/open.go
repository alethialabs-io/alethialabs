// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var openCmd = &cobra.Command{
	Use:       "open [console|docs]",
	Aliases:   []string{"docs", "dashboard"},
	Short:     "Open the Alethia console or docs in your browser",
	Long:      `Open the Alethia web console (default) or the documentation in your default browser.`,
	ValidArgs: []string{"console", "docs", "dashboard"},
	Args:      cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		target := "console"
		// `alethia docs` (the alias) defaults to the docs target.
		if cmd.CalledAs() == "docs" {
			target = "docs"
		}
		if len(args) > 0 {
			target = args[0]
		}

		var url string
		switch target {
		case "console", "dashboard":
			// The active ORG's page, not the bare origin. The origin 307s through a legacy
			// catch-all to wherever the console decides; naming the org is the same click
			// without the redirect, and it is what makes `--project` below a variation on one
			// rule rather than a special case.
			//
			// A machine that has authenticated but never switched org has no slug in its config
			// and one request answers it. The fallback is deliberate rather than fatal: `alethia
			// open` with no organization at all still has somewhere to go, and that is the origin.
			token, err := getAuthToken()
			if err != nil {
				// `--project` is the exception to the origin fallback, for the reason the docs
				// arm below states in the same words: a flag that is silently dropped is a flag
				// somebody will believe worked. Without a credential the project cannot be
				// resolved at all, so opening the console home page would answer a request for
				// one project with a page about none, and the only difference from success is a
				// URL nobody reads.
				if openProject != "" {
					fail(fmt.Errorf("resolve --project %q: %w", openProject, err))
				}
				url = WebOrigin()
				break
			}
			client := api.NewClient(token)
			if openProject != "" {
				// NAME or id, as every other --project in this CLI takes. An id has to be
				// resolved rather than slugified — see resolveProjectName.
				name, nameErr := resolveProjectName(client, openProject)
				if nameErr != nil {
					fail(nameErr)
				}
				if url, err = projectLink(client, name); err != nil {
					fail(err)
				}
				break
			}
			if url, err = orgLink(client); err != nil {
				url = WebOrigin()
			}
		case "docs":
			if openProject != "" {
				failf("--project names a console project and does not apply to the docs")
			}
			url = docsURL
		default:
			failf("unknown target %q (want console or docs)", target)
		}

		fmt.Printf("Opening %s\n", url)
		if err := openBrowser(url); err != nil {
			ui.Error(fmt.Sprintf("Failed to open browser: %v", err))
		}
	},
}

// openProject is the --project value: a project NAME OR ID, the same reference every other command
// takes. It is a flag rather than a second positional because `open [console|docs]` already spends
// its one argument on the surface, and a command that took `open boutique` could not tell a project
// named `docs` from the docs.
var openProject string

func init() {
	project := mustShellField("alethia open", shellKeyProject)
	openCmd.Flags().StringVar(&openProject, project.Flag, "", project.Usage)
	rootCmd.AddCommand(openCmd)
}
