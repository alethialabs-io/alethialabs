// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import "fmt"

// Cloudflare DNS — pluggable alternative to the cluster cloud's native DNS.
func init() {
	register("dns", "cloudflare", behavior{
		tfvars: func(ctx ComponentContext) map[string]any {
			zoneID := pcString(ctx.ProviderConfig, "zone_id", "")
			if zoneID == "" && ctx.Spec != nil {
				zoneID = ctx.Spec.DNS.ZoneID
			}
			domain := ""
			if ctx.Spec != nil {
				domain = ctx.Spec.DNS.DomainName
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
				return fmt.Errorf("Cloudflare credential not connected (missing api_token)")
			}
			if pcString(ctx.ProviderConfig, "zone_id", "") == "" &&
				(ctx.Spec == nil || ctx.Spec.DNS.ZoneID == "") {
				return fmt.Errorf("Cloudflare DNS requires a zone_id")
			}
			if ctx.Spec == nil || ctx.Spec.DNS.DomainName == "" {
				return fmt.Errorf("Cloudflare DNS requires a domain_name")
			}
			return nil
		},
	})
}
