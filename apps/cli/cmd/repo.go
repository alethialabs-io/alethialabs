// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"slices"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

var repoCmd = &cobra.Command{
	Use:     "repo",
	Aliases: []string{"repos", "repositories"},
	Short:   "Browse the git repositories Alethia can see",
	Long: `Lists the repositories reachable through a connected git provider (GitHub, GitLab or
Bitbucket): the ones a BYO chart or IaC source can be attached from.`,
}

var repoListCmd = &cobra.Command{
	Use:   "list",
	Short: "List repositories for a connected git provider",
	Args:  cobra.NoArgs,
	Long: `Lists the repositories Alethia can reach through one connected git provider: each one's name,
visibility, default branch and URL.

Use it to check that a repository is reachable before attaching it with "alethia chart attach" or
"alethia iac attach" — whose own forms offer the same list, so nothing has to be copied from here.
--provider picks the provider (github when omitted); on a terminal without it you are asked which.

--output json prints the repositories as an array, and --output csv the wire values.`,
	Run: func(cmd *cobra.Command, args []string) {
		provider, _ := cmd.Flags().GetString("provider")
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		p := printerFor(cmd)
		client := api.NewClient(token)
		if provider, err = promptRepoProvider(cmd, provider); err != nil {
			fail(err)
		}
		if interactiveTable(cmd) {
			var repos []api.Repository
			runSpinner("Fetching repositories...", func() {
				repos, err = client.GetRepositories(provider)
			})
			if err != nil {
				fail(fmt.Errorf("list %s repositories: %w", provider, err))
			}
			if len(repos) == 0 {
				fmt.Fprintln(p.Out, ui.MutedStyle.Render(fmt.Sprintf("No %s repositories found.", provider)))
				return
			}
			_ = ui.ShowTable(repoColumns, repoRows(repos, ui.FormatTable), "repositories")
			return
		}
		if err := runRepoList(client, p.Out, p.Format, provider); err != nil {
			fail(fmt.Errorf("list %s repositories: %w", provider, err))
		}
	},
}

// promptRepoProvider asks which connected git provider to browse.
//
// The provider HAS a default, so this reads canPromptForm rather than requireInteractiveForm — the
// rule output.go states for every defaulted field: a scripted caller is never REFUSED for omitting
// `--provider`, and a person at a terminal is still asked, because a default is rarely what they
// meant. `alethia repo list --no-input` therefore lists exactly what it listed before.
//
// It asks the SAME question promptRepoURL asks in front of the repository picker (byo_prompt.go),
// from the same gitProviders list and under the same field spec, so the two are one question about
// one thing rather than two that can come to disagree about which providers exist. The list is an
// OFFER and not a validation set: an unknown `--provider` still reaches the server, which is the
// only side that knows.
//
// The flag's own value seeds the select, so the cursor opens on the answer `--provider` would have
// given and a bare Enter changes nothing. It is appended when gitProviders does not carry it,
// because a picker that cannot offer the current value turns Enter into a silent change of it.
func promptRepoProvider(cmd *cobra.Command, provider string) (string, error) {
	if cmd.Flags().Changed("provider") || !canPromptForm() {
		return provider, nil
	}
	f := mustByoField("alethia repo list", byoKeyProvider)
	offered := append([]string{}, gitProviders...)
	if !slices.Contains(offered, provider) {
		offered = append(offered, provider)
	}
	options := make([]huh.Option[string], len(offered))
	for i, p := range offered {
		options[i] = huh.NewOption(p, p)
	}
	chosen := provider
	if err := runHuhForm(huh.NewGroup(
		huh.NewSelect[string]().Title(f.Title).Description(f.Description).Options(options...).Value(&chosen),
	)); err != nil {
		return provider, err
	}
	return chosen, nil
}

var repoColumns = []string{"Name", "Visibility", "Default branch", "URL"}

// repoRows projects repositories into table cells.
func repoRows(repos []api.Repository, outFmt string) [][]string {
	rows := make([][]string, len(repos))
	for i, r := range repos {
		visibility := "public"
		if r.Private {
			visibility = "private"
		}
		name := r.FullName
		if name == "" {
			name = r.Name
		}
		rows[i] = []string{name, visibility, ui.Cell(outFmt, r.DefaultBranch, ui.OrDash(r.DefaultBranch)), r.URL}
	}
	return rows
}

// runRepoList fetches and renders repositories for the given provider in the
// requested output format.
func runRepoList(c apiClient, out io.Writer, format, provider string) error {
	repos, err := c.GetRepositories(provider)
	if err != nil {
		return err
	}
	if len(repos) == 0 && format == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render(fmt.Sprintf("No %s repositories found.", provider)))
		return nil
	}
	return ui.Render(out, format, ui.TableSpec{
		Columns: repoColumns,
		Rows:    repoRows(repos, format),
	}, repos)
}

func init() {
	repoListCmd.Flags().String("provider", gitProviders[0], byoFlagUsage("alethia repo list", byoKeyProvider)+" ("+gitProvidersLabel()+")")
	repoCmd.AddCommand(repoListCmd)
	rootCmd.AddCommand(repoCmd)
}
