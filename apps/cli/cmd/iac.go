// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"os"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var iacCmd = &cobra.Command{
	Use:   "iac",
	Short: "Inspect a project's BYO Terraform/OpenTofu source",
	Long: `A BYO-IaC source is your own Terraform/OpenTofu module (pulled from a connected git
repo) that Alethia applies for an environment. Show the source attached to an environment
(defaults to the project's default environment; pass --env for another).`,
}

var iacShowCmd = &cobra.Command{
	Use:   "show",
	Short: "Show the BYO IaC source attached to a project environment",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		project, err := currentProject(cmd)
		if err != nil {
			fail(err)
		}
		env, _ := cmd.Flags().GetString("env")
		if err := runIacShow(api.NewClient(token), os.Stdout, outputFormat(cmd), project, env); err != nil {
			failf("Failed to get IaC source: %v", err)
		}
	},
}

// iacRows projects a BYO IaC source into field/value cells.
func iacRows(s *api.IacSource) [][]string {
	return [][]string{
		{"name", s.Name},
		{"repo", s.RepoURL},
		{"path", s.Path},
		{"ref", strOrDash(s.Ref)},
		{"enabled", fmt.Sprintf("%t", s.Enabled)},
		{"scan", s.ScanStatus},
		{"pinned commit", strOrDash(s.CommitSha)},
		{"deployed commit", strOrDash(s.DeployedCommitSha)},
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
	return ui.RenderCard(out, format, "alethia · IaC source", iacRows(src), src)
}

func init() {
	iacCmd.PersistentFlags().StringP("project", "p", "", "Project name or id")
	iacCmd.PersistentFlags().StringP("env", "e", "", "Environment name, stage, or id (default: the project's default environment)")
	iacCmd.AddCommand(iacShowCmd)
	rootCmd.AddCommand(iacCmd)
}
