// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/charmbracelet/huh"
)

// runnerOperatorLabel renders a runner's operator/provisioning as a short label:
// "managed", "self·deployed", or "self·registered".
func runnerOperatorLabel(w api.Runner) string {
	if w.Operator == "managed" {
		return "managed"
	}
	if w.Provisioning != "" {
		return "self·" + w.Provisioning
	}
	return "self"
}

// selectProject runs the interactive project picker shared by the project
// plan/apply/destroy commands. Projects are listed flat (top-level projects).
func selectProject(token string) (projectID string, err error) {
	if err := requireInteractive(); err != nil {
		return "", err
	}
	var configs []types.ConfigurationSummary

	ui.RunSpinner("Fetching projects...", func() {
		configs, err = api.NewClient(token).GetConfigurations()
	})

	if err != nil {
		return "", fmt.Errorf("failed to fetch projects: %w", err)
	}

	projectOptions := []huh.Option[string]{}
	for _, c := range configs {
		projectOptions = append(projectOptions, huh.NewOption(
			fmt.Sprintf("%s (%s)", c.ProjectName, c.EnvironmentStage),
			c.ID,
		))
	}

	if len(projectOptions) == 0 {
		return "", fmt.Errorf("no projects found — create one through Alethia")
	}

	err = ui.NewForm(
		huh.NewGroup(
			huh.NewSelect[string]().
				Title("Select Project").
				Description("Which project to operate on").
				Options(projectOptions...).
				Value(&projectID),
		),
	).Run()

	return projectID, err
}

var (
	statusOnline   = ui.SuccessStyle.Render(ui.SymbolOnline)
	statusOffline  = ui.MutedStyle.Render(ui.SymbolOffline)
	statusDraining = ui.WarningStyle.Render(ui.SymbolPending)
)

func selectRunner(token string, excludeID string) (runnerID string, err error) {
	if err := requireInteractive(); err != nil {
		return "", err
	}
	apiClient := api.NewClient(token)

	var runners []api.Runner

	ui.RunSpinner("Fetching runners...", func() {
		runners, err = apiClient.GetRunners()
	})

	if err != nil {
		return "", fmt.Errorf("failed to fetch runners: %w", err)
	}

	options := []huh.Option[string]{
		huh.NewOption(fmt.Sprintf("%s Any available", statusOnline), ""),
	}

	defaultValue := ""

	for _, w := range runners {
		if w.ID == excludeID {
			continue
		}

		var dot string
		switch w.Status {
		case "ONLINE":
			dot = statusOnline
		case "DRAINING":
			dot = statusDraining
		default:
			dot = statusOffline
		}

		label := fmt.Sprintf("%s %s (%s)", dot, w.Name, runnerOperatorLabel(w))
		if w.IsDefault {
			label += ui.DefaultBadge()
		}

		opt := huh.NewOption(label, w.ID)
		if w.Status != "ONLINE" {
			opt = opt.Selected(false)
		}
		options = append(options, opt)

		if w.IsDefault && w.Status == "ONLINE" {
			defaultValue = w.ID
		}
	}

	runnerID = defaultValue

	err = ui.NewForm(
		huh.NewGroup(
			huh.NewSelect[string]().
				Title("Select Runner").
				Description("Choose which runner runs this job").
				Options(options...).
				Value(&runnerID),
		),
	).Run()

	return runnerID, err
}

// selectOrgInteractive shows a picker for the active organization.
func selectOrgInteractive(orgs []api.OrgSummary) (*api.OrgSummary, error) {
	options := make([]huh.Option[string], len(orgs))
	for i, o := range orgs {
		label := fmt.Sprintf("%s (%s)", o.Name, o.Role)
		if o.IsActive {
			label += ui.DefaultBadge()
		}
		options[i] = huh.NewOption(label, o.ID)
	}
	var id string
	err := ui.NewForm(
		huh.NewGroup(
			huh.NewSelect[string]().
				Title("Select Organization").
				Description("Set the active organization context").
				Options(options...).
				Value(&id),
		),
	).Run()
	if err != nil {
		return nil, err
	}
	return matchOrg(orgs, id), nil
}

func selectCloudIdentity(token string) (identityID string, err error) {
	if err := requireInteractive(); err != nil {
		return "", err
	}
	apiClient := api.NewClient(token)

	var identities []api.CloudIdentity

	ui.RunSpinner("Fetching cloud accounts...", func() {
		identities, err = apiClient.GetCloudIdentities()
	})

	if err != nil {
		return "", fmt.Errorf("failed to fetch cloud identities: %w", err)
	}

	if len(identities) == 0 {
		return "", fmt.Errorf("no cloud accounts linked — connect one through Alethia first")
	}

	options := make([]huh.Option[string], len(identities))
	for i, id := range identities {
		options[i] = huh.NewOption(id.Label, id.ID)
	}

	err = ui.NewForm(
		huh.NewGroup(
			huh.NewSelect[string]().
				Title("Select Cloud Account").
				Description("Which cloud account to deploy into").
				Options(options...).
				Value(&identityID),
		),
	).Run()

	return identityID, err
}
