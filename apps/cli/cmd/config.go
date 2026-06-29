// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/spf13/cobra"
)

var configCmd = &cobra.Command{
	Use:   "config",
	Short: "Show or edit CLI configuration",
	Long: `Show the resolved CLI configuration — the control-plane URL and its source
(env / config / default), the active organization context, and the on-disk
credentials and config file locations. Use 'config set'/'config get' to edit.`,
	Run: func(cmd *cobra.Command, args []string) {
		credsPath, _ := getCredentialsPath()
		cfgPath, _ := types.CliConfigPath()
		origin, source := types.ResolveWebOrigin()
		if err := runConfigShow(
			os.Stdout, outputFormat(cmd),
			origin, source, types.LoadCliConfig(), credsPath, cfgPath,
		); err != nil {
			fail(err)
		}
	},
}

var configSetCmd = &cobra.Command{
	Use:   "set <key> <value>",
	Short: "Set a config value (key: web-origin)",
	Long:  `Persist a config value. Supported keys: web-origin (the control-plane URL).`,
	Args:  cobra.ExactArgs(2),
	Run: func(cmd *cobra.Command, args []string) {
		if err := runConfigSet(os.Stdout, args[0], args[1]); err != nil {
			fail(err)
		}
	},
}

var configGetCmd = &cobra.Command{
	Use:   "get [key]",
	Short: "Get a config value (key: web-origin, active-org)",
	Args:  cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		key := ""
		if len(args) > 0 {
			key = args[0]
		}
		if err := runConfigGet(os.Stdout, key); err != nil {
			fail(err)
		}
	},
}

var configClearContextCmd = &cobra.Command{
	Use:   "clear-context",
	Short: "Clear the active organization context",
	Run: func(cmd *cobra.Command, args []string) {
		cfg := types.LoadCliConfig()
		cfg.ActiveOrgID, cfg.ActiveOrgName, cfg.ActiveOrgSlug = "", "", ""
		if err := types.SaveCliConfig(cfg); err != nil {
			failf("Failed to clear context: %v", err)
		}
		ui.Success("Active organization context cleared.")
	},
}

// configView is the json projection of the CLI config.
type configView struct {
	WebOrigin       string `json:"web_origin"`
	WebOriginSource string `json:"web_origin_source"`
	ActiveOrgName   string `json:"active_org_name"`
	ActiveOrgID     string `json:"active_org_id"`
	CredentialsPath string `json:"credentials_path"`
	ConfigPath      string `json:"config_path"`
}

// runConfigShow renders the resolved CLI configuration as a Field/Value view
// (table/csv) or a json object, annotating the web-origin with its source.
func runConfigShow(out io.Writer, format, webOrigin string, source types.WebOriginSource, cfg types.CliConfig, credsPath, cfgPath string) error {
	view := configView{
		WebOrigin:       webOrigin,
		WebOriginSource: string(source),
		ActiveOrgName:   cfg.ActiveOrgName,
		ActiveOrgID:     cfg.ActiveOrgID,
		CredentialsPath: credsPath,
		ConfigPath:      cfgPath,
	}
	rows := [][]string{
		{"web origin", fmt.Sprintf("%s (%s)", webOrigin, source)},
		{"active org", orDash(cfg.ActiveOrgName)},
		{"active org id", orDash(cfg.ActiveOrgID)},
		{"credentials", credsPath},
		{"config", cfgPath},
	}
	return ui.RenderCard(out, format, "alethia · config", rows, view)
}

// runConfigSet validates and persists a single config key.
func runConfigSet(out io.Writer, key, value string) error {
	switch strings.ToLower(key) {
	case "web-origin", "web_origin":
		normalized, err := normalizeWebOrigin(value)
		if err != nil {
			return err
		}
		cfg := types.LoadCliConfig()
		cfg.WebOrigin = normalized
		if err := types.SaveCliConfig(cfg); err != nil {
			return fmt.Errorf("failed to save config: %w", err)
		}
		fmt.Fprintln(out, ui.FormatSuccess("web-origin set to "+normalized))
		return nil
	default:
		return fmt.Errorf("unknown config key %q (supported: web-origin)", key)
	}
}

// runConfigGet prints one or all config values.
func runConfigGet(out io.Writer, key string) error {
	cfg := types.LoadCliConfig()
	origin, _ := types.ResolveWebOrigin()
	switch strings.ToLower(key) {
	case "", "all":
		fmt.Fprintf(out, "web-origin: %s\n", origin)
		fmt.Fprintf(out, "active-org: %s\n", orDash(cfg.ActiveOrgName))
	case "web-origin", "web_origin":
		fmt.Fprintln(out, origin)
	case "active-org", "active_org":
		fmt.Fprintln(out, orDash(cfg.ActiveOrgName))
	default:
		return fmt.Errorf("unknown config key %q (supported: web-origin, active-org)", key)
	}
	return nil
}

// normalizeWebOrigin validates a control-plane URL and returns it without a
// trailing slash. It requires an http/https scheme and a host.
func normalizeWebOrigin(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", fmt.Errorf("invalid web-origin %q (want e.g. https://alethialabs.io)", raw)
	}
	return strings.TrimRight(raw, "/"), nil
}

// orDash returns s, or the dash glyph when s is empty.
func orDash(s string) string {
	if s == "" {
		return ui.SymbolDash
	}
	return s
}

// saveActiveOrg persists the chosen org as the active CLI context, preserving the
// rest of the config (e.g. web-origin).
func saveActiveOrg(o api.OrgSummary) error {
	cfg := types.LoadCliConfig()
	cfg.ActiveOrgID = o.ID
	cfg.ActiveOrgName = o.Name
	cfg.ActiveOrgSlug = o.Slug
	return types.SaveCliConfig(cfg)
}

func init() {
	configCmd.AddCommand(configSetCmd)
	configCmd.AddCommand(configGetCmd)
	configCmd.AddCommand(configClearContextCmd)
	rootCmd.AddCommand(configCmd)
}
