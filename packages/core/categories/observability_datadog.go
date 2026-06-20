// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import "fmt"

// Datadog — observability backend (metrics/logs/traces) installed in-cluster.
func init() {
	register("observability", "datadog", behavior{
		tfvars: func(ctx ComponentContext) map[string]any {
			return map[string]any{
				"datadog_api_key": cred(ctx.Credentials, "api_key", ""),
				"datadog_app_key": cred(ctx.Credentials, "app_key", ""),
				"datadog_site":    pcString(ctx.ProviderConfig, "site", "datadoghq.com"),
			}
		},
		validate: func(ctx ComponentContext) error {
			if cred(ctx.Credentials, "api_key", "") == "" || cred(ctx.Credentials, "app_key", "") == "" {
				return fmt.Errorf("missing Datadog api_key or app_key (credential not connected)")
			}
			return nil
		},
	})
}
