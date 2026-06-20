// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import "fmt"

// Grafana Cloud — in-cluster agent remote-writing metrics to Grafana Cloud.
func init() {
	register("observability", "grafana", behavior{
		tfvars: func(ctx ComponentContext) map[string]any {
			return map[string]any{
				"grafana_instance_id":      cred(ctx.Credentials, "instance_id", ""),
				"grafana_api_token":        cred(ctx.Credentials, "api_token", ""),
				"grafana_remote_write_url": pcString(ctx.ProviderConfig, "remote_write_url", ""),
			}
		},
		validate: func(ctx ComponentContext) error {
			if cred(ctx.Credentials, "instance_id", "") == "" || cred(ctx.Credentials, "api_token", "") == "" {
				return fmt.Errorf("missing Grafana Cloud instance_id or api_token (credential not connected)")
			}
			if pcString(ctx.ProviderConfig, "remote_write_url", "") == "" {
				return fmt.Errorf("remote_write_url required for Grafana Cloud")
			}
			return nil
		},
	})
}
