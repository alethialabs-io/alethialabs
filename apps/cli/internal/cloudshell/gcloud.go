// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloudshell

import (
	"encoding/base64"
	"fmt"
)

// EnsureGcloud verifies gcloud is installed and has an active account. The
// Cloud Shell session itself is authenticated from these local credentials, so
// a missing or stale login surfaces here (and as the reauth error the user
// sees) rather than mid-install.
func EnsureGcloud() error {
	if !have("gcloud") {
		return ErrGcloudNotFound
	}
	account, err := runCapture(
		"gcloud", "auth", "list",
		"--filter=status:ACTIVE", "--format=value(account)",
	)
	if err != nil || account == "" {
		return ErrGcloudNotAuthed
	}
	return nil
}

// RunGcpSetupInCloudShell pushes the embedded installer into the user's Google
// Cloud Shell, runs it against the given project, and returns the WIF
// credential config JSON it prints. The installer runs inside Cloud Shell,
// which already has gcloud authenticated to the user's GCP org.
func RunGcpSetupInCloudShell(script, projectID string) (string, error) {
	encoded := base64.StdEncoding.EncodeToString([]byte(script))
	remoteCmd := fmt.Sprintf(
		"echo %s | base64 -d > /tmp/alethia-gcp-setup.sh && bash /tmp/alethia-gcp-setup.sh %s",
		encoded, shellQuote(projectID),
	)

	output, err := runStreaming(
		"gcloud", "cloud-shell", "ssh", "--authorize-session",
		fmt.Sprintf("--command=%s", remoteCmd),
	)
	if err != nil {
		return "", fmt.Errorf("cloud shell command failed: %w", err)
	}

	wif, ok := extractBetweenMarkers(output)
	if !ok {
		return "", fmt.Errorf("could not find WIF config in installer output")
	}
	return wif, nil
}
