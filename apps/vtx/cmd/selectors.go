// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"

	"github.com/bobikenobi12/bb-thesis-2026/packages/vertex-core/api"
	"github.com/bobikenobi12/bb-thesis-2026/packages/vertex-core/types"
	"github.com/charmbracelet/huh"
	"github.com/charmbracelet/huh/spinner"
	"github.com/bobikenobi12/bb-thesis-2026/apps/vtx/pkg/utils/ui"
	"github.com/imroc/req/v3"
)

func getWebOrigin() string {
	return WebOrigin()
}

func selectVineyard(token string) (vineyardID, vineyardName string, err error) {
	webOrigin := getWebOrigin()
	reqClient := req.C()

	var vResult struct {
		Vineyards []types.Vineyard `json:"vineyards"`
	}

	spinner.New().
		Title("Fetching vineyards...").
		Action(func() {
			_, err = reqClient.R().
				SetBearerAuthToken(token).
				SetSuccessResult(&vResult).
				Get(fmt.Sprintf("%s/api/cli/vineyards", webOrigin))
		}).Run()

	if err != nil {
		return "", "", fmt.Errorf("failed to fetch vineyards: %w", err)
	}

	if len(vResult.Vineyards) == 0 {
		return "", "", fmt.Errorf("no vineyards found — create one first via Vertex or `vtx vineyard create`")
	}

	vOptions := make([]huh.Option[string], len(vResult.Vineyards))
	for i, v := range vResult.Vineyards {
		vOptions[i] = huh.NewOption(v.Name, v.ID)
	}

	err = huh.NewForm(
		huh.NewGroup(
			huh.NewSelect[string]().
				Title("Select Vineyard").
				Description("Which workspace to use").
				Options(vOptions...).
				Value(&vineyardID),
		),
	).Run()

	if err != nil {
		return "", "", err
	}

	for _, v := range vResult.Vineyards {
		if v.ID == vineyardID {
			vineyardName = v.Name
			break
		}
	}

	return vineyardID, vineyardName, nil
}

func selectVine(token string, vineyardID string) (vineID string, err error) {
	webOrigin := getWebOrigin()
	reqClient := req.C()

	var configsResult struct {
		Configurations []types.ConfigurationSummary `json:"configurations"`
	}

	spinner.New().
		Title("Fetching vines...").
		Action(func() {
			_, err = reqClient.R().
				SetBearerAuthToken(token).
				SetSuccessResult(&configsResult).
				Get(fmt.Sprintf("%s/api/cli/configurations", webOrigin))
		}).Run()

	if err != nil {
		return "", fmt.Errorf("failed to fetch vines: %w", err)
	}

	vineOptions := []huh.Option[string]{}
	for _, c := range configsResult.Configurations {
		if vineyardID == "" || (c.VineyardID != nil && *c.VineyardID == vineyardID) {
			vineOptions = append(vineOptions, huh.NewOption(
				fmt.Sprintf("%s (%s)", c.ProjectName, c.EnvironmentStage),
				c.ID,
			))
		}
	}

	if len(vineOptions) == 0 {
		return "", fmt.Errorf("no vines found in this vineyard — create one through Vertex")
	}

	err = huh.NewForm(
		huh.NewGroup(
			huh.NewSelect[string]().
				Title("Select Vine").
				Description("Which vine to operate on").
				Options(vineOptions...).
				Value(&vineID),
		),
	).Run()

	return vineID, err
}

var (
	statusOnline   = ui.SuccessStyle.Render(ui.SymbolOnline)
	statusOffline  = ui.MutedStyle.Render(ui.SymbolOffline)
	statusDraining = ui.WarningStyle.Render(ui.SymbolPending)
)

func selectTendril(token string, excludeID string) (tendrilID string, err error) {
	apiClient := api.NewClient(token)

	var workers []api.Worker

	spinner.New().
		Title("Fetching tendrils...").
		Action(func() {
			workers, err = apiClient.GetWorkers()
		}).Run()

	if err != nil {
		return "", fmt.Errorf("failed to fetch tendrils: %w", err)
	}

	options := []huh.Option[string]{
		huh.NewOption(fmt.Sprintf("%s Any available", statusOnline), ""),
	}

	defaultValue := ""

	for _, w := range workers {
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

		modeLabel := "cloud"
		if w.Mode == "self-hosted" {
			modeLabel = "self"
		}

		label := fmt.Sprintf("%s %s (%s)", dot, w.Name, modeLabel)
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

	tendrilID = defaultValue

	err = huh.NewForm(
		huh.NewGroup(
			huh.NewSelect[string]().
				Title("Select Tendril").
				Description("Choose which tendril runs this job").
				Options(options...).
				Value(&tendrilID),
		),
	).Run()

	return tendrilID, err
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
		return "", fmt.Errorf("no cloud accounts linked — connect one through Vertex first")
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
