// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package types

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// DefaultWebOrigin is the hosted Alethia control plane. The CLI points here with
// zero configuration; self-hosters / dev override it via ALETHIA_WEB_ORIGIN or
// `alethia config set web-origin <url>`.
const DefaultWebOrigin = "https://alethialabs.io"

// CliConfig is the persisted, non-secret CLI state stored alongside the
// credentials file (`{UserConfigDir}/alethia/config.json`). It holds the active
// organization context selected via `alethia org switch`, which the API client
// sends as the `X-Alethia-Org` header so the control plane resolves the caller's
// scope into that org. Credentials (tokens) live in the separate credentials.json.
type CliConfig struct {
	WebOrigin     string `json:"web_origin,omitempty"`
	ActiveOrgID   string `json:"active_org_id,omitempty"`
	ActiveOrgName string `json:"active_org_name,omitempty"`
	ActiveOrgSlug string `json:"active_org_slug,omitempty"`
}

// WebOriginSource identifies where the resolved control-plane URL came from.
type WebOriginSource string

const (
	WebOriginFromEnv     WebOriginSource = "env"
	WebOriginFromConfig  WebOriginSource = "config"
	WebOriginFromDefault WebOriginSource = "default"
)

// ResolveWebOrigin returns the control-plane URL and its source, in precedence
// order: the ALETHIA_WEB_ORIGIN env var, then the persisted config, then the
// hosted default. This is the single resolver used by both the CLI commands and
// the API client so prod needs no setup and self-host/dev set it once.
func ResolveWebOrigin() (string, WebOriginSource) {
	if v := os.Getenv("ALETHIA_WEB_ORIGIN"); v != "" {
		return v, WebOriginFromEnv
	}
	if cfg := LoadCliConfig(); cfg.WebOrigin != "" {
		return cfg.WebOrigin, WebOriginFromConfig
	}
	return DefaultWebOrigin, WebOriginFromDefault
}

// CliConfigPath returns the absolute path to the CLI config file.
func CliConfigPath() (string, error) {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(configDir, "alethia", "config.json"), nil
}

// LoadCliConfig reads the CLI config, returning a zero-value config when the file
// is absent or unreadable (an unset context is not an error).
func LoadCliConfig() CliConfig {
	var cfg CliConfig
	path, err := CliConfigPath()
	if err != nil {
		return cfg
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return cfg
	}
	_ = json.Unmarshal(data, &cfg)
	return cfg
}

// SaveCliConfig writes the CLI config, creating the alethia config directory if
// it does not exist.
func SaveCliConfig(cfg CliConfig) error {
	path, err := CliConfigPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}
