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

/**
 * Evidence-gated production parties; status changes require operational evidence.
 *
 * A PURPOSE is as evidence-gated as a party. "Masked session replay" was listed against PostHog and
 * was removed with consent v2 (#2371): the product does not run replay and offers no choice for it,
 * so a purpose describing it made the public register describe processing that does not happen.
 * Over-disclosure is not the safe direction — a register nobody can reconcile with the product is
 * not a truthful register.
 */
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
		id: "stripe",
		name: "Stripe Payments Europe, Ltd.",
		purposes: [
			{
				name: "Subscription billing, payment processing, invoices, and statutory transaction records",
				lawfulBasis: "contract",
				consentRequired: false,
			},
		],
		role: "subprocessor",
		// ACTIVE. Stripe was absent from this register entirely while the console's billing, invoice
		// and AI-credit paths were live and the pricing page said "billed monthly through Stripe" —
		// so the public privacy notice told data subjects that payment-card details were not
		// collected. That is the most serious kind of error this register exists to prevent: an
		// omission here is not under-disclosure, it is a false statement (#2371).
		status: "active",
		region: "Ireland (EEA), with global card-network processing",
		evidenceId: "ops:billing:stripe-live:2026-08-24",
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
	return [...PROCESSING_PARTIES, ...CUSTOMER_DIRECTED_PARTIES].filter(
		(party) =>
			party.status === "active" || party.status === "customer-directed",
	);
}

/**
 * Providers the CUSTOMER points Alethia at, disclosed as conditional rather than current.
 *
 * These are categories, deliberately not company names. Alethia has no agreement with, and no
 * knowledge of, which cloud or git host or model endpoint a given customer connects — the connector
 * registry (apps/console/lib/connectors) defines the SHAPES that can be connected, not a list of
 * parties anyone is actually using. Naming companies here would assert relationships this repository
 * cannot evidence, and an unevidenced name in a processing register is the same defect as a missing
 * one, pointing the other way.
 *
 * They carry `customer-directed`, so `publicProcessingParties` renders them alongside active parties
 * and the page can mark them clearly conditional — which is what "plus clearly conditional
 * customer-directed providers" requires.
 */
export const CUSTOMER_DIRECTED_PARTIES: readonly ProcessingParty[] = [
	{
		id: "customer-cloud",
		name: "The cloud provider you connect",
		purposes: [
			{
				name: "Provision and operate the infrastructure you asked Alethia to create in your own account",
				lawfulBasis: "contract",
				consentRequired: false,
			},
		],
		role: "subprocessor",
		status: "customer-directed",
		region: "The account and region you choose",
		evidenceId: "code:connectors:cloud:2026-08-24",
	},
	{
		id: "customer-git",
		name: "The git host you connect",
		purposes: [
			{
				name: "Read and write the GitOps repository you nominate",
				lawfulBasis: "contract",
				consentRequired: false,
			},
		],
		role: "subprocessor",
		status: "customer-directed",
		region: "Determined by the host you choose",
		evidenceId: "code:connectors:git:2026-08-24",
	},
	{
		id: "customer-connector",
		name: "The DNS, secret-store, registry or observability service you connect",
		purposes: [
			{
				name: "Perform the operations you configure against a service you supply credentials for",
				lawfulBasis: "contract",
				consentRequired: false,
			},
		],
		role: "subprocessor",
		status: "customer-directed",
		region: "Determined by the service you choose",
		evidenceId: "code:connectors:pluggable:2026-08-24",
	},
	{
		id: "customer-ai-endpoint",
		name: "The AI model endpoint you configure",
		purposes: [
			{
				name: "Answer a request you make of the AI feature, using the context you submit",
				lawfulBasis: "contract",
				consentRequired: false,
			},
		],
		role: "subprocessor",
		status: "customer-directed",
		region: "Determined by the endpoint you configure",
		evidenceId: "code:ai:configured-endpoint:2026-08-24",
	},
];

/**
 * The consent cookie's name, as the public device-storage disclosure must state it.
 *
 * Kept as a named constant next to the disclosure rather than typed inline, because it was typed
 * inline once and went stale the moment the consent version moved: the register named
 * `alethia_consent_v1` while the browser held `alethia_consent_v2`, which is a cookie disclosure a
 * reader cannot verify by opening their own devtools.
 *
 * `@repo/legal` deliberately does not import `@repo/privacy` — this package is the LEAF the
 * marketing site and the console both read, and the privacy package is a client-side React module.
 * A test in packages/privacy asserts the two agree, so the duplication cannot drift silently.
 */
export const CONSENT_COOKIE_NAME = "alethia_consent_v2";

/** Browser storage allowed by the verified foundation. */
export const DEVICE_STORAGE: readonly DeviceStorageEntry[] = [
	{
		name: "better-auth session cookies",
		category: "necessary",
		purpose: "Authenticate and secure console sessions",
	},
	{
		name: CONSENT_COOKIE_NAME,
		category: "necessary",
		purpose: "Remember the analytics choice and policy version",
	},
];



/** Paid conversion stays fail-closed until the commerce phase records evidence. */
export const PAID_MARKETS: readonly string[] = [];
