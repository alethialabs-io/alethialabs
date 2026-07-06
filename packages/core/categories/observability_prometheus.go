// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

// Prometheus — in-cluster Prometheus, optionally remote-writing to an external
// store. Remote-write credentials are optional (a local-only install is valid).
func init() {
	register("observability", "prometheus", behavior{
		tfvars: func(ctx ComponentContext) map[string]any {
			return map[string]any{
				"prometheus_remote_write_url":      pcString(ctx.ProviderConfig, "remote_write_url", ""),
				"prometheus_remote_write_username": cred(ctx.Credentials, "remote_write_username", ""),
				"prometheus_remote_write_password": cred(ctx.Credentials, "remote_write_password", ""),
				"prometheus_retention_days":        pcString(ctx.ProviderConfig, "retention_days", "15"),
			}
		},
		// No required fields — a local-only Prometheus install is valid.
		validate: nil,
	})
}
