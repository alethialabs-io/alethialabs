// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var iacCmd = &cobra.Command{
	Use:   "iac",
	Short: "Attach, scan and inspect a project's BYO Terraform/OpenTofu source",
	Long: `A BYO-IaC source is your own Terraform/OpenTofu module, pulled from a connected git
repository, that Alethia applies for one environment. An environment holds at most one.

Attach it with "alethia iac attach", scan it with "alethia iac scan" (an unscanned source is
refused at deploy), read it back with "alethia iac show", and detach it with "alethia iac detach".
--project and --env work on every subcommand; the environment defaults to the project's default.`,
}

var iacShowCmd = &cobra.Command{
	Use:   "show",
	Short: "Show the BYO IaC source attached to a project environment",
	Args:  cobra.NoArgs,
	Long: `Shows the BYO Terraform/OpenTofu source attached to one environment: its repository, path and
ref, whether it is enabled, its scan state, the commit a deploy will apply and the commit the last
deploy applied.

Use it to check that a source is scanned before a deploy, or which commit is live. With no source
attached it says so (and --output json prints null).

Name the project with --project; omit it on a terminal and you are asked which. With nobody to
ask, it is required (exit 9).`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		// The output format is resolved BEFORE the project: `-o bogus` is rejected without first
		// opening a picker, and interactiveTable is what decides whether the picker may run at all.
		p := printerFor(cmd)
		project, err := byoProject(cmd, token, interactiveTable(cmd))
		if err != nil {
			fail(err)
		}
		env, _ := cmd.Flags().GetString("env")
		if err := runIacShow(api.NewClient(token), p.Out, p.Format, project, env); err != nil {
			fail(fmt.Errorf("read IaC source: %w", err))
		}
	},
}

// iacRows projects a BYO IaC source into field/value cells.
func iacRows(s *api.IacSource, outFmt string) [][]string {
	return [][]string{
		{"name", s.Name},
		{"repo", s.RepoURL},
		{"path", s.Path},
		{"ref", ui.Cell(outFmt, ui.Wire(s.Ref), ui.StrOrDash(s.Ref))},
		{"enabled", fmt.Sprintf("%t", s.Enabled)},
		{"scan", s.ScanStatus},
		{"pinned commit", ui.Cell(outFmt, ui.Wire(s.CommitSha), ui.StrOrDash(s.CommitSha))},
		{"deployed commit", ui.Cell(outFmt, ui.Wire(s.DeployedCommitSha), ui.StrOrDash(s.DeployedCommitSha))},
		{"status", s.Status},
	}
}

// runIacShow fetches and renders a project environment's BYO IaC source. json emits the whole
// source object (or null); table/csv render the field/value card.
func runIacShow(c apiClient, out io.Writer, format, project, env string) error {
	src, err := c.GetProjectIacSource(project, env)
	if err != nil {
		return err
	}
	if format == ui.FormatJSON {
		return ui.Render(out, format, ui.TableSpec{}, src)
	}
	if src == nil {
		fmt.Fprintln(out, ui.MutedStyle.Render("No BYO IaC source attached."))
		return nil
	}
	return ui.RenderCard(out, format, "alethia · IaC source", iacRows(src, format), src)
}

func init() {
	iacCmd.PersistentFlags().StringP("project", "p", "", byoFlagUsage("alethia iac", byoKeyProject))
	iacCmd.PersistentFlags().StringP("env", "e", "", byoFlagUsage("alethia iac", byoKeyEnv))
	iacCmd.AddCommand(iacShowCmd)
	rootCmd.AddCommand(iacCmd)
}
