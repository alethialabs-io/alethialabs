package cmd

import (
	"encoding/json"
	"os"
	"path/filepath"
)

type WorkerCredentials struct {
	WorkerID    string `json:"worker_id"`
	WorkerToken string `json:"worker_token"`
	WorkerName  string `json:"worker_name,omitempty"`
	TrellisURL  string `json:"trellis_url,omitempty"`
}

func getWorkerConfigPath() (string, error) {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(configDir, "grape", "worker.json"), nil
}

func saveWorkerCredentials(creds WorkerCredentials) error {
	path, err := getWorkerConfigPath()
	if err != nil {
		return err
	}

	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}

	data, err := json.MarshalIndent(creds, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(path, data, 0600)
}

func loadWorkerCredentials() *WorkerCredentials {
	path, err := getWorkerConfigPath()
	if err != nil {
		return nil
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}

	var creds WorkerCredentials
	if err := json.Unmarshal(data, &creds); err != nil {
		return nil
	}

	return &creds
}
