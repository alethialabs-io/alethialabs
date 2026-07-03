// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { DnsProviderConfig } from "@/types/jsonb.types";
import type { CloudProviderSlug } from "./registry";

interface WafOption {
	providerConfigKey: keyof DnsProviderConfig;
	label: string;
	description: string;
	cost: string;
}

/** WAF options per provider (shown as toggles in the DNS section). */
export const WAF_OPTIONS: Record<CloudProviderSlug, WafOption[]> = {
	aws: [
		{
			providerConfigKey: "cloudfront_waf",
			label: "CloudFront WAF",
			description: "Web Application Firewall for CloudFront distributions",
			cost: "~$5/mo",
		},
		{
			providerConfigKey: "application_waf",
			label: "Application WAF",
			description: "Web Application Firewall for ALB/NLB",
			cost: "~$5/mo",
		},
	],
	gcp: [
		{
			providerConfigKey: "cloud_armor",
			label: "Cloud Armor",
			description: "DDoS protection and WAF for load balancers",
			cost: "~$5/mo",
		},
	],
	azure: [
		{
			providerConfigKey: "azure_waf",
			label: "Azure WAF",
			description: "Web Application Firewall on Application Gateway",
			cost: "~$13/mo",
		},
	],
};

interface CertOption {
	providerConfigKey: keyof DnsProviderConfig;
	label: string;
	description: string;
}

/** Managed certificate options per provider. */
export const CERT_OPTIONS: Record<CloudProviderSlug, CertOption> = {
	aws: {
		providerConfigKey: "acm_certificate",
		label: "ACM Certificate",
		description: "Free TLS certificate managed by AWS Certificate Manager",
	},
	gcp: {
		providerConfigKey: "managed_certificate",
		label: "Google-Managed Certificate",
		description: "Free TLS certificate managed by Google Cloud",
	},
	azure: {
		providerConfigKey: "managed_certificate",
		label: "App Service Certificate",
		description: "Managed TLS certificate from Azure",
	},
};
