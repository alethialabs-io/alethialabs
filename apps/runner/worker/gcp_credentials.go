// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package worker

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
)

func ActivateGcpWIF(wifConfigJSON string, projectID string) (func(), error) {
	if wifConfigJSON == "" {
		return nil, fmt.Errorf("empty WIF config")
	}

	tmpFile, err := os.CreateTemp("", "alethia-wif-*.json")
	if err != nil {
		return nil, fmt.Errorf("failed to create temp file: %w", err)
	}

	if _, err := tmpFile.Write([]byte(wifConfigJSON)); err != nil {
		tmpFile.Close()
		os.Remove(tmpFile.Name())
		return nil, fmt.Errorf("failed to write WIF config: %w", err)
	}
	tmpFile.Close()

	// On ECS Fargate, AWS creds are available via the container credentials endpoint,
	// not via env vars or EC2 metadata. The WIF config expects EC2 metadata, so we
	// fetch the ECS credentials and set them as env vars for the Google SDK to use.
	exportedECSCreds := exportECSCredentials()

	os.Setenv("GOOGLE_APPLICATION_CREDENTIALS", tmpFile.Name())
	if projectID != "" {
		os.Setenv("GOOGLE_PROJECT", projectID)
		os.Setenv("GCLOUD_PROJECT", projectID)
		os.Setenv("CLOUDSDK_CORE_PROJECT", projectID)
	}

	cleanup := func() {
		os.Unsetenv("GOOGLE_APPLICATION_CREDENTIALS")
		os.Unsetenv("GOOGLE_PROJECT")
		os.Unsetenv("GCLOUD_PROJECT")
		os.Unsetenv("CLOUDSDK_CORE_PROJECT")
		os.Remove(tmpFile.Name())
		if exportedECSCreds {
			os.Unsetenv("AWS_ACCESS_KEY_ID")
			os.Unsetenv("AWS_SECRET_ACCESS_KEY")
			os.Unsetenv("AWS_SESSION_TOKEN")
		}
	}

	return cleanup, nil
}

// exportECSCredentials fetches temporary AWS credentials from the ECS container
// credentials endpoint and sets them as env vars. Returns true if credentials were set.
func exportECSCredentials() bool {
	if os.Getenv("AWS_ACCESS_KEY_ID") != "" {
		return false
	}

	relativeURI := os.Getenv("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI")
	if relativeURI == "" {
		return false
	}

	resp, err := http.Get("http://169.254.170.2" + relativeURI)
	if err != nil {
		return false
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return false
	}

	var creds struct {
		AccessKeyId     string `json:"AccessKeyId"`
		SecretAccessKey string `json:"SecretAccessKey"`
		Token           string `json:"Token"`
	}
	if err := json.Unmarshal(body, &creds); err != nil {
		return false
	}

	if creds.AccessKeyId == "" {
		return false
	}

	os.Setenv("AWS_ACCESS_KEY_ID", creds.AccessKeyId)
	os.Setenv("AWS_SECRET_ACCESS_KEY", creds.SecretAccessKey)
	os.Setenv("AWS_SESSION_TOKEN", creds.Token)
	return true
}
