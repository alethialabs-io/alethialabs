// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/charmbracelet/huh"
	"github.com/charmbracelet/huh/spinner"
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

func selectZone(token string) (zoneID, zoneName string, err error) {
	var zones []api.ZoneWithSpecs

	spinner.New().
		Title("Fetching zones...").
		Action(func() {
			zones, err = api.NewClient(token).GetZones()
		}).Run()

	if err != nil {
		return "", "", fmt.Errorf("failed to fetch zones: %w", err)
	}

	if len(zones) == 0 {
		return "", "", fmt.Errorf("no zones found — create one first via Alethia or `alethia zone create`")
	}

	vOptions := make([]huh.Option[string], len(zones))
	for i, v := range zones {
		vOptions[i] = huh.NewOption(v.Name, v.ID)
	}

	err = huh.NewForm(
		huh.NewGroup(
			huh.NewSelect[string]().
				Title("Select Zone").
				Description("Which workspace to use").
				Options(vOptions...).
				Value(&zoneID),
		),
	).Run()

	if err != nil {
		return "", "", err
	}

	for _, v := range zones {
		if v.ID == zoneID {
			zoneName = v.Name
			break
		}
	}

	return zoneID, zoneName, nil
}

func selectSpec(token string, zoneID string) (specID string, err error) {
	var configs []types.ConfigurationSummary

	spinner.New().
		Title("Fetching specs...").
		Action(func() {
			configs, err = api.NewClient(token).GetConfigurations()
		}).Run()

	if err != nil {
		return "", fmt.Errorf("failed to fetch specs: %w", err)
	}

	specOptions := []huh.Option[string]{}
	for _, c := range configs {
		if zoneID == "" || (c.ZoneID != nil && *c.ZoneID == zoneID) {
			specOptions = append(specOptions, huh.NewOption(
				fmt.Sprintf("%s (%s)", c.ProjectName, c.EnvironmentStage),
				c.ID,
			))
		}
	}

	if len(specOptions) == 0 {
		return "", fmt.Errorf("no specs found in this zone — create one through Alethia")
	}

	err = huh.NewForm(
		huh.NewGroup(
			huh.NewSelect[string]().
				Title("Select Spec").
				Description("Which spec to operate on").
				Options(specOptions...).
				Value(&specID),
		),
	).Run()

	return specID, err
}

var (
	statusOnline   = ui.SuccessStyle.Render(ui.SymbolOnline)
	statusOffline  = ui.MutedStyle.Render(ui.SymbolOffline)
	statusDraining = ui.WarningStyle.Render(ui.SymbolPending)
)

func selectRunner(token string, excludeID string) (runnerID string, err error) {
	apiClient := api.NewClient(token)

	var runners []api.Runner

	spinner.New().
		Title("Fetching runners...").
		Action(func() {
			runners, err = apiClient.GetRunners()
		}).Run()

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

	err = huh.NewForm(
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

func selectCloudIdentity(token string) (identityID string, err error) {
	apiClient := api.NewClient(token)

	var identities []api.CloudIdentity

	spinner.New().
		Title("Fetching cloud accounts...").
		Action(func() {
			identities, err = apiClient.GetCloudIdentities()
		}).Run()

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

	err = huh.NewForm(
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
