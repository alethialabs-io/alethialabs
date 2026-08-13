// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

export type ProcessingPartyStatus =
	"active" | "customer-directed" | "inactive" | "planned";

export interface ProcessingPurpose {
	readonly name: string;
	readonly lawfulBasis: "consent" | "contract" | "legitimate-interests";
	readonly consentRequired: boolean;
}

export interface ProcessingParty {
	readonly id: string;
	readonly name: string;
	readonly purposes: readonly ProcessingPurpose[];
	readonly role: "independent-controller" | "subprocessor";
	readonly status: ProcessingPartyStatus;
	readonly region: string;
	readonly evidenceId: string;
}

export interface DeviceStorageEntry {
	readonly name: string;
	readonly category: "necessary";
	readonly purpose: string;
}

/** Evidence-gated production parties; status changes require operational evidence. */
export const PROCESSING_PARTIES: readonly ProcessingParty[] = [
	{
		id: "hetzner",
		name: "Hetzner Online GmbH",
		purposes: [
			{
				name: "Hosted compute, database, backups, and object storage",
				lawfulBasis: "contract",
				consentRequired: false,
			},
		],
		role: "subprocessor",
		status: "active",
		region: "Germany",
		evidenceId: "ops:hosting:2026-08-12",
	},
	{
		id: "cloudflare",
		name: "Cloudflare, Inc.",
		purposes: [
			{
				name: "DNS, edge security, TLS, traffic delivery, and inbound email routing",
				lawfulBasis: "legitimate-interests",
				consentRequired: false,
			},
		],
		role: "subprocessor",
		status: "active",
		region: "EEA and global edge network",
		evidenceId: "ops:edge:2026-08-12",
	},
	{
		id: "resend",
		name: "Resend, Inc.",
		purposes: [
			{
				name: "Temporary transactional email delivery",
				lawfulBasis: "contract",
				consentRequired: false,
			},
		],
		role: "subprocessor",
		status: "active",
		region: "United States",
		evidenceId: "ops:email:2026-08-12",
	},
	{
		id: "posthog",
		name: "PostHog, Inc.",
		purposes: [
			{
				name: "Pseudonymous product analytics, funnels, and Web Vitals",
				lawfulBasis: "consent",
				consentRequired: true,
			},
			{
				name: "Masked session replay",
				lawfulBasis: "consent",
				consentRequired: true,
			},
			{
				name: "Client error diagnostics after analytics consent",
				lawfulBasis: "consent",
				consentRequired: true,
			},
			{
				name: "Server and migration error diagnostics and operational logs",
				lawfulBasis: "legitimate-interests",
				consentRequired: false,
			},
		],
		role: "subprocessor",
		status: "active",
		region: "European Union",
		evidenceId: "ops:analytics:2026-08-12",
	},
	{
		id: "aws-ses",
		name: "Amazon Web Services EMEA SARL",
		purposes: [
			{
				name: "Planned transactional email delivery",
				lawfulBasis: "contract",
				consentRequired: false,
			},
		],
		role: "subprocessor",
		status: "inactive",
		region: "European Union",
		evidenceId: "ops:email:ses-rejected:2026-08-12",
	},
	{
		id: "grafana-prometheus",
		name: "Alethia-operated Grafana and Prometheus",
		purposes: [
			{
				name: "Planned self-hosted operational observability",
				lawfulBasis: "legitimate-interests",
				consentRequired: false,
			},
		],
		role: "subprocessor",
		status: "planned",
		region: "Germany",
		evidenceId: "ops:observability:planned:2026-08-12",
	},
];

/** Parties that may be rendered in public processing disclosures. */
export function publicProcessingParties(): readonly ProcessingParty[] {
	return PROCESSING_PARTIES.filter(
		(party) =>
			party.status === "active" || party.status === "customer-directed",
	);
}

/** Browser storage allowed by the verified foundation. */
export const DEVICE_STORAGE: readonly DeviceStorageEntry[] = [
	{
		name: "better-auth session cookies",
		category: "necessary",
		purpose: "Authenticate and secure console sessions",
	},
	{
		name: "alethia_consent_v1",
		category: "necessary",
		purpose: "Remember the analytics choice and policy version",
	},
];

/** Paid conversion stays fail-closed until the commerce phase records evidence. */
export const PAID_MARKETS: readonly string[] = [];
