// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/charmbracelet/huh"
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
				name, nameErr := openProjectName(client, openProject)
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

// openProjectName maps `--project` to the console `[project]` segment's NAME, and offers the
// picker when the reference names no project this organization has.
//
// # Why `open` asks about the PROJECT and never about the target
//
// shell_fields.go records that `open`'s positional deliberately does not prompt: it has a default,
// and a bare `alethia open` opening the console is the right command, so a picker in front of the
// commonest invocation would be a cost with nothing bought. That decision stands and this function
// does not touch it — the target is still answered, never asked, and `alethia open --no-input` with
// no flag still opens the console without a question. `--project` is the other value, added later
// (#4308), and it is the one with no default and no way to be asked for at all.
//
// # Why an unknown reference is a REFUSAL rather than a link
//
// resolveProjectName returns a non-UUID reference unchanged and without a request, which is right
// for its callers and wrong here: `open` turns the answer into a URL, so a mistyped name became a
// console 404 that looks exactly like a working command. The project list is closed and org-scoped
// and this link is built for the same org, so a reference outside it is one the console would
// certainly refuse — which is the bound the CLI puts on what a client may reject (the same one
// resolveClassification applies to a dimension key), and it buys a refusal that names the real
// projects, or, on a terminal, a picker instead of a retype.
//
// A name shared by two projects keeps projectLink's documented residual: such a link is suffixed
// server-side and 404s rather than opening the wrong project.
func openProjectName(c projectLister, ref string) (string, error) {
	configs, err := c.GetConfigurations()
	if err != nil {
		return "", fmt.Errorf("resolve --project %q: %w", ref, err)
	}
	for _, cfg := range configs {
		if cfg.ID != ref && !strings.EqualFold(cfg.ProjectName, ref) {
			continue
		}
		if cfg.ProjectName == "" {
			return "", fmt.Errorf("project %q has no name to build a console link from", ref)
		}
		return cfg.ProjectName, nil
	}

	if ferr := requireInteractiveForm(); ferr != nil {
		return "", fmt.Errorf("no project %q in this organization (have: %s) (%w)",
			ref, knownProjectNames(configs), ferr)
	}
	options := make([]huh.Option[string], 0, len(configs))
	for _, cfg := range configs {
		if cfg.ProjectName == "" {
			continue
		}
		options = append(options, huh.NewOption(
			fmt.Sprintf("%s (%s)", cfg.ProjectName, cfg.EnvironmentStage), cfg.ProjectName))
	}
	if len(options) == 0 {
		// Nothing to offer, so nothing is asked: an empty picker is a box a reader cannot answer,
		// and "this org has no named project" is a different problem from "you picked none".
		return "", fmt.Errorf("no project %q in this organization (have: %s)",
			ref, knownProjectNames(configs))
	}
	chosen := options[0].Value
	if err := runHuhForm(huh.NewGroup(
		// The title is the one promptProjectNameRef already uses, so the two project pickers in
		// this CLI read as one question rather than two. The shell group's spec carries no Title
		// column (shell_fields.go describes flags, not form fields), so there is nothing to
		// resolve it from without adding a rendering that nothing holds in step.
		huh.NewSelect[string]().
			Title("Select Project").
			Description("Which project's console page to open").
			Options(options...).
			Value(&chosen),
	)); err != nil {
		return "", err
	}
	return chosen, nil
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
