// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"io"
	"os"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

var (
	projectCreateRegion     string
	projectCreateIdentity   string
	projectCreateStage      string
	projectCreateIacVersion string
)

var projectCreateCmd = &cobra.Command{
	Use:   "create <name>",
	Short: "Create a new project",
	Long: `Create a new project (an infrastructure app) in the active organization. A default
environment is created with it; add component resources afterwards with
"alethia project component add". Pass --region and --cloud-identity-id, or omit them on a
TTY to be prompted.`,
	Args: cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}

		region := projectCreateRegion
		if region == "" {
			if region, err = promptRegion(); err != nil {
				fail(err)
			}
		}
		identity := projectCreateIdentity
		if identity == "" && !noInputMode {
			// Best-effort interactive pick; a project may be created without a cloud account.
			identity, _ = selectCloudIdentity(token)
		}

		params := api.CreateProjectParams{
			ProjectName:     args[0],
			Region:          region,
			CloudIdentityID: identity,
			Stage:           projectCreateStage,
			IacVersion:      projectCreateIacVersion,
		}
		if err := runProjectCreate(api.NewClient(token), os.Stdout, outputFormat(cmd), params); err != nil {
			failf("Failed to create project: %v", err)
		}
	},
}

// promptRegion asks for the project's region when it wasn't passed (TTY only).
func promptRegion() (string, error) {
	if err := requireInteractive(); err != nil {
		return "", err
	}
	var region string
	err := ui.NewForm(
		huh.NewGroup(
			huh.NewInput().
				Title("Region").
				Description("The cloud region to provision into (e.g. eu-west-1)").
				Value(&region),
		),
	).Run()
	return strings.TrimSpace(region), err
}

// runProjectCreate creates the project and renders it as a card (non-interactive path).
func runProjectCreate(c apiClient, out io.Writer, format string, params api.CreateProjectParams) error {
	project, err := c.CreateProject(params)
	if err != nil {
		return err
	}
	return renderProjectCard(out, format, project)
}

// renderProjectCard renders a single project as a Field/Value card (table/csv) or the typed
// object (json).
func renderProjectCard(out io.Writer, format string, p *api.Project) error {
	provider := ui.SymbolDash
	if p.CloudProvider != "" {
		provider = strings.ToUpper(p.CloudProvider)
	}
	rows := [][]string{
		{"Project", p.ProjectName},
		{"Slug", orDash(p.Slug)},
		{"Status", p.Status},
		{"Provider", provider},
		{"Region", p.Region},
		{"Env", p.EnvironmentStage},
		{"IaC", p.IacVersion},
		{"ID", p.ID},
	}
	return ui.RenderCard(out, format, "alethia · project", rows, p)
}

func init() {
	projectCreateCmd.Flags().StringVar(&projectCreateRegion, "region", "", "Cloud region to provision into")
	projectCreateCmd.Flags().StringVar(&projectCreateIdentity, "cloud-identity-id", "", "Cloud account (identity) id to link")
	projectCreateCmd.Flags().StringVar(&projectCreateStage, "stage", "development", "Initial environment stage (development|staging|production)")
	projectCreateCmd.Flags().StringVar(&projectCreateIacVersion, "iac-version", "", "OpenTofu version to pin (defaults server-side)")
	projectCmd.AddCommand(projectCreateCmd)
}
