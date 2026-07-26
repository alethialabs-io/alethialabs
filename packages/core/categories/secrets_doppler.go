// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import "fmt"

// Doppler — a SaaS external secrets store the cloud identity can't natively reach. The tofu module
// manages a placeholder `doppler_secret` per project secret under the connection's project+config
// (apps/operators populate real values). Auth is a WRITE-CAPABLE Doppler API token (a personal or
// Service-Account token — a read-only service token is single-scope and cannot manage secrets).
func init() {
	register("secrets", "doppler", behavior{
		tfvars: func(ctx ComponentContext) map[string]any {
			return map[string]any{
				"doppler_token":   cred(ctx.Credentials, "token", ""),
				"doppler_project": pcString(ctx.ProviderConfig, "project", ""),
				"doppler_config":  pcString(ctx.ProviderConfig, "config", ""),
				"secret_names":    itemNames(ctx.Items),
			}
		},
		validate: func(ctx ComponentContext) error {
			if cred(ctx.Credentials, "token", "") == "" {
				return fmt.Errorf("Doppler credential not connected (missing API token)")
			}
			if pcString(ctx.ProviderConfig, "project", "") == "" || pcString(ctx.ProviderConfig, "config", "") == "" {
				return fmt.Errorf("Doppler project/config not set (provider_config.project, provider_config.config)")
			}
			return nil
		},
	})
}
