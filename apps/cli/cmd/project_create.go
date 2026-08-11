// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
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
	projectCreatePlacement  string
	projectCreateEnvs       []string
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

		environments, err := parseEnvMatrix(projectCreateEnvs)
		if err != nil {
			fail(err)
		}
		params := api.CreateProjectParams{
			ProjectName:     args[0],
			Region:          region,
			CloudIdentityID: identity,
			Stage:           projectCreateStage,
			IacVersion:      projectCreateIacVersion,
			Placement:       projectCreatePlacement,
			Environments:    environments,
		}
		if err := runProjectCreate(api.NewClient(token), os.Stdout, outputFormat(cmd), params); err != nil {
			failf("Failed to create project: %v", err)
		}
	},
}

// parseEnvMatrix turns repeatable `--env name:stage[:mode[:namespace]]` flags into the environment
// MATRIX the create front door fans out. Nothing is defaulted here beyond the placement mode: the
// server validates the matrix with the console form's own schema, so inventing values locally would
// only move a rejection further from the thing that decides it.
//
// The first entry is the DEFAULT environment. The matrix is what makes a two-tier project cost one
// cluster instead of two — without it every environment comes out `dedicated`.
//
//	--env prod:production                          → dedicated (the default mode for a first env)
//	--env dev:development:namespace:boutique-dev   → placed as a namespace on the shared Fabric
//	--env staging:staging:vcluster                 → placed as a vcluster, namespace derived
func parseEnvMatrix(specs []string) ([]api.EnvironmentSpec, error) {
	if len(specs) == 0 {
		return nil, nil
	}
	out := make([]api.EnvironmentSpec, 0, len(specs))
	seen := map[string]bool{}
	for _, raw := range specs {
		parts := strings.Split(raw, ":")
		if len(parts) < 2 || len(parts) > 4 {
			return nil, fmt.Errorf("invalid --env %q (want name:stage[:mode[:namespace]])", raw)
		}
		name := strings.TrimSpace(parts[0])
		stage := strings.TrimSpace(parts[1])
		if name == "" || stage == "" {
			return nil, fmt.Errorf("invalid --env %q — name and stage are both required", raw)
		}
		if seen[name] {
			return nil, fmt.Errorf("--env lists %q twice", name)
		}
		seen[name] = true

		spec := api.EnvironmentSpec{
			Name:  name,
			Stage: stage,
			// The FIRST entry owns the Fabric it provisions, so it defaults to `dedicated`; a later
			// entry defaults to `namespace`, the cheap rung. Both are overridable per entry.
			PlacementMode: "namespace",
			IsDefault:     len(out) == 0,
		}
		if len(out) == 0 {
			spec.PlacementMode = "dedicated"
		}
		if len(parts) >= 3 && strings.TrimSpace(parts[2]) != "" {
			spec.PlacementMode = strings.TrimSpace(parts[2])
		}
		if len(parts) == 4 {
			spec.Namespace = strings.TrimSpace(parts[3])
		}
		out = append(out, spec)
	}
	return out, nil
}

// promptRegion asks for the project's region when it wasn't passed (TTY only).
func promptRegion() (string, error) {
	if err := requireInteractive(); err != nil {
		return "", err
	}
	var region string
	err := runHuhForm(
		huh.NewGroup(
			huh.NewInput().
				Title("Region").
				Description("The cloud region to provision into (e.g. eu-west-1)").
				Value(&region),
		),
	)
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
	projectCreateCmd.Flags().StringVar(&projectCreatePlacement, "placement-mode", "", "Placement of the default environment: namespace|vcluster|dedicated (default dedicated)")
	projectCreateCmd.Flags().StringArrayVar(&projectCreateEnvs, "env", nil, "Environment as name:stage[:mode[:namespace]] (repeatable; the first is the default). Without this the legacy Production+Preview pair is created")
	projectCmd.AddCommand(projectCreateCmd)
}
