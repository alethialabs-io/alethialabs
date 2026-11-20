// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/format"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/spf13/cobra"
)

var projectGetCmd = &cobra.Command{
	Use:   "get [name]",
	Short: "Show one project's configuration",
	Long: `Print a project's full configuration: its region, cloud account, cluster and the settings of its default environment.

Use it to read a project back after creating or changing it. The project is named by its NAME,
as the argument or with --project. Omit it on a terminal and you are asked, so the name never
has to be copied out of another command's output. --open also opens the project in the console.`,
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		if err := runProjectGet(cmd, args); err != nil {
			fail(err)
		}
	},
}

// projectGetName resolves which project `project get` prints: the argument, --project, or the
// picker. Naming it twice is refused, because the two could disagree and one would be ignored.
func projectGetName(cmd *cobra.Command, args []string, token string) (string, error) {
	flag, _ := cmd.Flags().GetString("project")
	flag = strings.TrimSpace(flag)
	arg := ""
	if len(args) == 1 {
		arg = strings.TrimSpace(args[0])
	}
	switch {
	case arg != "" && flag != "":
		return "", refusal(clierr.CodeInvalidUsage, "",
			"the project is named twice, as the argument %q and as --project %q: pass one", arg, flag)
	case arg != "":
		return arg, nil
	case flag != "":
		return flag, nil
	}
	// promptProjectNameRef, not promptProjectRef: GetConfiguration resolves by project NAME only,
	// so the id that one falls back to for a shared name would 404.
	name, err := promptProjectNameRef(token)
	return name, flagRequired(err, "the project name (the argument, or --project)", "alethia project list")
}

// runProjectGet prints one project, and opens it in the console when --open was given.
func runProjectGet(cmd *cobra.Command, args []string) error {
	token, err := getAuthToken()
	if err != nil {
		return err
	}
	projectName, err := projectGetName(cmd, args, token)
	if err != nil {
		return err
	}

	outFmt := outputFormat(cmd)
	client := api.NewClient(token)
	config, err := client.GetConfiguration(projectName)
	if err != nil {
		return fmt.Errorf("failed to fetch project %q: %w", projectName, err)
	}
	if config == nil || config.ID == "" {
		return refusal(clierr.CodeNotFound, "alethia project list", "no project named %q", projectName)
	}

	if outFmt != ui.FormatTable {
		// json emits the whole record; csv emits the summary rows.
		if err := ui.RenderCard(printer.Out, outFmt, "", projectSummaryRows(*config), config); err != nil {
			return err
		}
	} else {
		ui.PrintConfiguration(*config)
	}

	if open, _ := cmd.Flags().GetBool("open"); open {
		openProjectInConsole(client, config.ProjectName)
	}
	return nil
}

// openProjectInConsole opens a project's console page. A link that cannot be built, or a browser
// that will not start, is reported on stderr and is NOT the command's exit status: the project has
// already been printed, so `alethia project get web --open && …` must not fail a script on the
// optional half.
func openProjectInConsole(c orgSlugFetcher, projectName string) {
	// THE PROJECT, not `{origin}/dashboard` — the URL comes from the console's own route tree
	// (packages/core/routing).
	url, err := projectLink(c, projectName)
	if err != nil {
		printer.Warn(fmt.Sprintf("Could not build the project link: %v", err))
		return
	}
	printer.Note("Opening " + url)
	if err := openBrowser(url); err != nil {
		printer.Warn(fmt.Sprintf("Could not open a browser: %v. Open the link above yourself.", err))
	}
}

// projectSummaryRows returns the scalar summary fields of a project config for
// the csv projection (json emits the full typed object).
func projectSummaryRows(c types.Configuration) [][]string {
	rows := [][]string{
		{"ID", c.ID},
		{"Project", c.ProjectName},
		{"Environment", string(c.EnvironmentStage)},
		{"Container Platform", c.ContainerPlatform},
		{"Cloud Account ID", c.CloudAccountID},
		{"Region", c.Region},
		{"IaC Version", c.IacVersion},
	}
	if !c.UpdatedAt.IsZero() {
		// `2006-01-02 15:04:05` was one of five copies of that layout in the CLI. One absolute
		// date, the console's, in UTC — the host zone would make the same project print two
		// different times on two machines.
		rows = append(rows, []string{"Last Updated", format.Date(c.UpdatedAt, format.DateTime, time.UTC)})
	}
	return rows
}

func init() {
	projectCmd.AddCommand(projectGetCmd)
	projectGetCmd.Flags().String("project", "", "Project to show, by NAME (the same as the argument; asked for on a terminal when omitted)")
	// Note: -o is reserved for the global --output flag, so --open is long-only.
	projectGetCmd.Flags().Bool("open", false, "Also open the project in the console in your browser")
}
