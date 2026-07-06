// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import "fmt"

// Cloudflare DNS — pluggable alternative to the cluster cloud's native DNS.
func init() {
	register("dns", "cloudflare", behavior{
		tfvars: func(ctx ComponentContext) map[string]any {
			zoneID := pcString(ctx.ProviderConfig, "zone_id", "")
			if zoneID == "" && ctx.Project != nil {
				zoneID = ctx.Project.DNS.ZoneID
			}
			domain := ""
			if ctx.Project != nil {
				domain = ctx.Project.DNS.DomainName
			}
			return map[string]any{
				"cloudflare_api_token": cred(ctx.Credentials, "api_token", ""),
				"cloudflare_zone_id":   zoneID,
				"domain_name":          domain,
				"proxied":              pcBool(ctx.ProviderConfig, "proxied", false),
			}
		},
		validate: func(ctx ComponentContext) error {
			if cred(ctx.Credentials, "api_token", "") == "" {
				return fmt.Errorf("missing Cloudflare api_token (credential not connected)")
			}
			if pcString(ctx.ProviderConfig, "zone_id", "") == "" &&
				(ctx.Project == nil || ctx.Project.DNS.ZoneID == "") {
				return fmt.Errorf("zone_id required for Cloudflare DNS")
			}
			if ctx.Project == nil || ctx.Project.DNS.DomainName == "" {
				return fmt.Errorf("domain_name required for Cloudflare DNS")
			}
			return nil
		},
	})
}
