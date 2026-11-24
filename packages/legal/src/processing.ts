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
		id: "paddle",
		name: "Paddle.com Market Ltd (Paddle.com Inc. for buyers in the United States)",
		purposes: [
			{
				name: "Reselling self-serve subscriptions, usage and AI credits as merchant of record: payment processing, sales tax and VAT, customer invoices, refunds and chargebacks, and fraud prevention",
				lawfulBasis: "contract",
				consentRequired: false,
			},
		],
		// An INDEPENDENT CONTROLLER, not our processor: Paddle sells to the buyer in its own name as
		// reseller and merchant of record, under its own Buyer Terms and privacy notice, and decides
		// for itself what payment, tax and fraud data it needs. We receive the order and subscription
		// outcome, never the card.
		role: "independent-controller",
		// PLANNED until the go-live PR: no card sale goes through Paddle while MOR_MARKETS is empty
		// (mor-markets.ts), and a planned party is not rendered on the subprocessors page. Flip to
		// `active` with an operational evidence id (live account, first transaction) when it opens.
		status: "planned",
		region: "United Kingdom (Paddle.com Market Ltd) and United States (Paddle.com Inc.)",
		evidenceId: "decision:billing:paddle-mor:2026-11-24",
	},
	{
		id: "aws-ses",
		name: "Amazon Web Services EMEA SARL",
		purposes: [
			{
				name: "Transactional email delivery (sign-in codes, account, billing and support email) and bounce and complaint notifications",
				lawfulBasis: "contract",
				consentRequired: false,
			},
		],
		role: "subprocessor",
		// ACTIVE since hosted production moved to Amazon SES in the dedicated alethia-email account
		// (infra/email-ses-account), which replaced Resend. The deploy defaults EMAIL_PROVIDER to ses
		// and refuses resend (scripts/ci/check-email-provider-keys.sh). The Resend entry was removed
		// with the transport rather than marked inactive: inactive parties are not rendered, and a
		// processor that receives nothing does not belong in the register.
		status: "active",
		region: "Germany (eu-central-1, Frankfurt)",
		evidenceId: "ops:email:ses-alethia-email:2026-11-21",
	},
	{
		id: "anthropic",
		name: "Anthropic",
		purposes: [
			{
				name: "AI assistant requests: your prompt and the Service context sent with it, only while the assistant is switched on",
				lawfulBasis: "contract",
				consentRequired: false,
			},
		],
		role: "subprocessor",
		// ACTIVE because the hosted assistant's default models are Anthropic's
		// (apps/console/lib/config/ai.ts, DEFAULT_EXECUTOR and DEFAULT_ADVISOR_*) and the hosted deploy
		// passes Alethia's own ANTHROPIC_API_KEY (scripts/ci/deploy-console-assemble-env.sh). The customer
		// configures no endpoint, so this is Alethia's subprocessor, not a customer-directed one: the
		// "AI model endpoint you configure" category that stood here described a choice the hosted
		// product does not offer. Whether the assistant is ON is a vault fact (isAiConfigured() fails
		// closed until the DPA, transfer, retention and no-training values are recorded), which is why
		// the purpose says "only while the assistant is switched on" and the legal-set claim is
		// outside-repo. OpenAI is not listed: no default model resolves to it, and it receives requests
		// only if an operator sets an openai/* model override.
		status: "active",
		region: "United States",
		evidenceId: "code:ai:default-provider-anthropic:2026-11-22",
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
 * knowledge of, which cloud or git host or connector service a given customer connects — the connector
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


