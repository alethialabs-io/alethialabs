// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// A scaler-provisioned VM boots without runner credentials. It presents the shared
// bootstrap token and self-registers, receiving a runner id + token (ADR 08). Dedup
// is by the VM's instance id, so a reboot reuses the same runner row.

type bootstrapRequest struct {
	Providers  []string `json:"providers,omitempty"`
	InstanceID string   `json:"instanceId,omitempty"`
}

type bootstrapResponse struct {
	RunnerID    string `json:"runner_id"`
	RunnerToken string `json:"runner_token"`
}

// BootstrapRunner exchanges a bootstrap token for runner credentials. Returns the
// runner id + token to use for the rest of the process's life.
func BootstrapRunner(alethiaURL, bootstrapToken string, providers []string) (string, string, error) {
	payload, _ := json.Marshal(bootstrapRequest{
		Providers:  providers,
		InstanceID: resolveInstanceID(),
	})
	req, err := http.NewRequest("POST", alethiaURL+"/api/runners/bootstrap", bytes.NewBuffer(payload))
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Authorization", "Bearer "+bootstrapToken)
	req.Header.Set("Content-Type", "application/json")

	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return "", "", fmt.Errorf("bootstrap request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return "", "", fmt.Errorf("bootstrap returned %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}

	var out bootstrapResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", "", fmt.Errorf("decode bootstrap response: %w", err)
	}
	if out.RunnerID == "" || out.RunnerToken == "" {
		return "", "", fmt.Errorf("bootstrap response missing credentials")
	}
	return out.RunnerID, out.RunnerToken, nil
}

// resolveInstanceID best-effort reads the Hetzner metadata service so the control
// plane can dedup one runner per VM; falls back to the hostname. An explicit
// ALETHIA_RUNNER_INSTANCE_ID override wins first — it lets several runners on one
// host (e.g. local dev, where the metadata service is unreachable and the hostname
// is shared) self-register as distinct rows instead of colliding on one name.
func resolveInstanceID() string {
	if v := strings.TrimSpace(os.Getenv("ALETHIA_RUNNER_INSTANCE_ID")); v != "" {
		return v
	}
	req, err := http.NewRequest("GET", "http://169.254.169.254/hetzner/v1/metadata/instance-id", nil)
	if err == nil {
		if resp, err := (&http.Client{Timeout: time.Second}).Do(req); err == nil {
			defer resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				if b, err := io.ReadAll(io.LimitReader(resp.Body, 256)); err == nil {
					if id := strings.TrimSpace(string(b)); id != "" {
						return id
					}
				}
			}
		}
	}
	if h, err := os.Hostname(); err == nil {
		return h
	}
	return ""
}
