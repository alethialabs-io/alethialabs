// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package state

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/alethialabs-io/alethialabs/packages/core/utils"
	"gopkg.in/yaml.v3"
)

var sensitiveFields = map[string]bool{
	"applications_argo_access_token": true,
	"gitops_argo_access_token":       true,
}

type State struct{}

func NewState() *State {
	return &State{}
}

func (s *State) SaveInfraFacts(rawConfig map[string]interface{}, outputs map[string]interface{}, dryRun bool, logger *utils.Logger) error {
	logger.Info("Saving infra-facts.yaml", "state")
	toYAML := make(map[string]interface{})

	for k, v := range rawConfig {
		if sensitiveFields[k] {
			continue
		}
		switch v.(type) {
		case float64, string, int, bool:
			toYAML[k] = v
		}
	}

	if len(outputs) > 0 {
		logger.Info("Including OpenTofu outputs.", "state")
		for key, output := range outputs {
			toYAML[key] = output
		}
	} else {
		if dryRun {
			logger.Warn("No OpenTofu outputs found. This is expected in dry-run mode.", "state")
		} else {
			return fmt.Errorf("no OpenTofu outputs found in non-dry-run mode")
		}
	}

	finalMap := map[string]interface{}{
		"infra-services": toYAML,
	}

	yamlData, err := yaml.Marshal(finalMap)
	if err != nil {
		return fmt.Errorf("failed to marshal state to YAML: %w", err)
	}

	tempDir := "temp"
	if err := os.MkdirAll(tempDir, 0755); err != nil {
		return fmt.Errorf("failed to create temp directory: %w", err)
	}

	outputPath := filepath.Join(tempDir, "infra-facts.yaml")
	if err := os.WriteFile(outputPath, yamlData, 0644); err != nil {
		return fmt.Errorf("failed to write infra-facts.yaml: %w", err)
	}

	logger.Info(fmt.Sprintf("Saved infra-facts.yaml to %s", outputPath), "state")
	return nil
}

func RawConfigFromFullConfig(fullConfig *string) (map[string]interface{}, error) {
	if fullConfig == nil || *fullConfig == "" {
		return nil, fmt.Errorf("no raw config available")
	}
	var raw map[string]interface{}
	if err := json.Unmarshal([]byte(*fullConfig), &raw); err != nil {
		return nil, fmt.Errorf("failed to parse full config: %w", err)
	}
	return raw, nil
}
