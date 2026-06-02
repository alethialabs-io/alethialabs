package cmd

import (
	"fmt"
	"os"

	"github.com/bobikenobi12/bb-thesis-2026/packages/grape-core/api"
	"github.com/bobikenobi12/bb-thesis-2026/packages/grape-core/types"
	"github.com/charmbracelet/huh"
	"github.com/charmbracelet/huh/spinner"
	"github.com/imroc/req/v3"
)

func getWebOrigin() string {
	webOrigin := os.Getenv("GRAPE_WEB_ORIGIN")
	if webOrigin == "" {
		webOrigin = "https://adp.prod.itgix.eu"
	}
	return webOrigin
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
		return "", "", fmt.Errorf("no vineyards found — create one first via Trellis or `grape vineyard create`")
	}

	vOptions := make([]huh.Option[string], len(vResult.Vineyards))
	for i, v := range vResult.Vineyards {
		vOptions[i] = huh.NewOption(v.Name, v.ID)
	}

	err = huh.NewForm(
		huh.NewGroup(
			huh.NewSelect[string]().
				Title("Select Vineyard").
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

type vineSummary struct {
	ID          string
	ProjectName string
	VineyardID  string
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
		return "", fmt.Errorf("no vines found in this vineyard — create one through Trellis")
	}

	err = huh.NewForm(
		huh.NewGroup(
			huh.NewSelect[string]().
				Title("Select Vine").
				Options(vineOptions...).
				Value(&vineID),
		),
	).Run()

	return vineID, err
}

func selectWorker(token string) (workerID string, err error) {
	apiClient := api.NewClient(token)

	var workers []api.Worker

	spinner.New().
		Title("Fetching workers...").
		Action(func() {
			workers, err = apiClient.GetWorkers()
		}).Run()

	if err != nil {
		return "", fmt.Errorf("failed to fetch workers: %w", err)
	}

	if len(workers) == 0 {
		return "", fmt.Errorf("no workers found — register one with `grape worker register`")
	}

	workerOptions := make([]huh.Option[string], len(workers))
	for i, w := range workers {
		label := fmt.Sprintf("%s (%s) [%s]", w.Name, w.Mode, w.Status)
		if w.IsDefault {
			label += " ★"
		}
		workerOptions[i] = huh.NewOption(label, w.ID)
	}

	err = huh.NewForm(
		huh.NewGroup(
			huh.NewSelect[string]().
				Title("Select Worker").
				Options(workerOptions...).
				Value(&workerID),
		),
	).Run()

	return workerID, err
}
