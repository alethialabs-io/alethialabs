// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Signup onboarding: give every new user a real, named organization (slug = their
// provider username) and make them its owner. Runs from the Better Auth
// user.create.after hook. The org plugin is EE-gated and not loaded at init, so we
// write organization/member directly; resolveOrgScope reads these tables anyway.

import { asc, eq } from "drizzle-orm";
import type { PayerCapacity } from "@repo/legal/commerce";
import { COUNTRY_OPTIONS } from "@repo/ui/countries";
import { ensureMemberGrant } from "@/lib/authz/grants";
import { getServiceDb } from "@/lib/db";
import { member, organization, organizationBilling, user } from "@/lib/db/schema";
import { pickFreeSlug, RESERVED_SLUGS } from "@/lib/routing";
import { slugify } from "@/lib/utils/slugify";
import { log } from "@/lib/observability/log";

interface NewUser {
	id: string;
	email: string;
	name?: string | null;
	username?: string | null;
}

/** The email local-part (`bob@x.com` → `bob`), or "" when unusable. */
function emailLocalPart(email: string): string {
	return email.split("@")[0] ?? "";
}

/**
 * Provisions a new user's primary organization: a real `organization` row named
 * after them (slug = their username, globally unique via pickFreeSlug), an owner
 * `member` row, and an owner grant mirrored into the PDP/OpenFGA. Idempotent — a
 * no-op once the user belongs to any org.
 */
export async function provisionPrimaryOrg(u: NewUser): Promise<void> {
	const db = getServiceDb();

	// Idempotency: skip if the user already has a membership.
	const existingMember = await db
		.select({ id: member.id })
		.from(member)
		.where(eq(member.userId, u.id))
		.limit(1);
	if (existingMember.length > 0) return;

	// Handle: prefer the provider username, then the display name, then the email
	// local-part. Drives both the org's display name and its slug.
	const handle = u.username || u.name || emailLocalPart(u.email) || "user";
	const orgName = `${handle}'s Org`;

	const taken = await db
		.select({ slug: organization.slug })
		.from(organization);
	const slug = pickFreeSlug(slugify(handle, "org"), [
		...taken.map((r) => r.slug),
		...RESERVED_SLUGS,
	]);

	const [org] = await db
		.insert(organization)
		.values({ name: orgName, slug })
		.returning({ id: organization.id });
	if (!org) return;

	await db.insert(member).values({
		organizationId: org.id,
		userId: u.id,
		role: "owner",
		status: "active",
	});

	// Owner grant for the new org (Postgres grant + OpenFGA tuple mirror).
	await ensureMemberGrant(org.id, u.id, "owner");
}

/** The user's primary organization (earliest membership) — the org the /onboarding
 *  flow configures in place. Provisioned at signup by provisionPrimaryOrg. */
export interface PrimaryOrg {
	id: string;
	name: string;
	slug: string;
	logo: string | null;
	role: string;
}

/** Resolves the user's primary org (earliest membership), or null if none. */
export async function getPrimaryOrg(userId: string): Promise<PrimaryOrg | null> {
	const [row] = await getServiceDb()
		.select({
			id: organization.id,
			name: organization.name,
			slug: organization.slug,
			logo: organization.logo,
			role: member.role,
		})
		.from(organization)
		.innerJoin(member, eq(member.organizationId, organization.id))
		.where(eq(member.userId, userId))
		.orderBy(asc(member.createdAt))
		.limit(1);
	if (!row) return null;
	// slug is non-null in practice (provisionPrimaryOrg always sets one); coerce
	// the nullable column type for the consumer.
	return { ...row, slug: row.slug ?? "" };
}

/**
 * The user's primary org, provisioning one first if it is missing.
 *
 * `provisionPrimaryOrg` runs from the `user.create.after` hook, where a failure is
 * logged and swallowed — it must not abort account creation. That left a real hole:
 * a user with no `member` row and a NULL `onboarding_completed_at` could not be served
 * by /dashboard (which routes them to /onboarding) *or* /onboarding (which had nothing
 * to configure), and the two bounced the user between them forever.
 *
 * So the read side repairs instead of redirecting. This is safe to call on every
 * /onboarding render: `provisionPrimaryOrg` is idempotent — it returns early once the
 * user holds any membership — so the happy path costs one indexed lookup and no write.
 *
 * Returns null only when provisioning genuinely cannot succeed (the DB or the PDP is
 * down), which the caller must render as a terminal error rather than a redirect.
 */
export async function ensurePrimaryOrg(
	userId: string,
): Promise<PrimaryOrg | null> {
	const existing = await getPrimaryOrg(userId);
	if (existing) return existing;

	const [row] = await getServiceDb()
		.select({ email: user.email, name: user.name, username: user.username })
		.from(user)
		.where(eq(user.id, userId))
		.limit(1);
	// No user row for a live session — nothing to provision against.
	if (!row) return null;

	try {
		await provisionPrimaryOrg({
			id: userId,
			email: row.email,
			name: row.name,
			username: row.username,
		});
	} catch (e) {
		log.error("[onboarding] org repair failed", { err: e });
		return null;
	}
	return getPrimaryOrg(userId);
}

/**
 * Whether the user has finished the post-signup /onboarding setup flow. Drives the
 * post-login gate: a NULL `onboarding_completed_at` (brand-new signup) routes the
 * user into /onboarding; pre-existing users are backfilled and skip it.
 */
export async function isOnboardingComplete(userId: string): Promise<boolean> {
	const [row] = await getServiceDb()
		.select({ at: user.onboardingCompletedAt })
		.from(user)
		.where(eq(user.id, userId))
		.limit(1);
	return Boolean(row?.at);
}

/** Marks the current user's onboarding as finished (idempotent). */
export async function completeOnboarding(userId: string): Promise<void> {
	await getServiceDb()
		.update(user)
		.set({ onboardingCompletedAt: new Date() })
		.where(eq(user.id, userId));
}

/**
 * Where a person's post-signup setup stands, decided on the server (WIZ-W6, #6929).
 *
 * The page reads this before it renders anything, so what /onboarding shows never depends on what
 * the browser last did. Before this, the page asked `isOnboardingComplete` alone and never looked at
 * the org's plan: a reload between a trial starting and the completion write rendered the plan
 * chooser again, offering a trial the account had already used.
 *
 *  - `complete`: setup was finished before; nothing to show.
 *  - `settled`: not marked finished, but the org already has a live plan (`active` or `trialing`).
 *    The trial (or plan) happened and only the completion write is missing, so the page writes it
 *    and moves on. The form is never shown again for it.
 *  - `in-flight`: the org names a Stripe subscription that is not live yet (Stripe's `incomplete`,
 *    which the billing sync stores as `none`). A payment is unconfirmed; the page says so and
 *    offers no way to start another plan.
 *  - `not-started`: the form.
 *  - `no-org`: the primary org is missing and could not be repaired (`ensurePrimaryOrg`).
 *  - `unknown`: a read failed. Never treated as `not-started`, which would offer the trial to an
 *    account whose state nobody could see.
 */
export type OnboardingResolution =
	| { readonly kind: "complete" }
	| { readonly kind: "settled"; readonly org: PrimaryOrg }
	| { readonly kind: "in-flight"; readonly org: PrimaryOrg }
	| { readonly kind: "not-started"; readonly org: PrimaryOrg }
	| { readonly kind: "no-org" }
	| { readonly kind: "unknown" };

/** Asks the database where this user's setup stands. See {@link OnboardingResolution}. */
export async function resolveOnboarding(userId: string): Promise<OnboardingResolution> {
	try {
		if (await isOnboardingComplete(userId)) return { kind: "complete" };
		const org = await ensurePrimaryOrg(userId);
		if (!org) return { kind: "no-org" };
		const [row] = await getServiceDb()
			.select({
				status: organizationBilling.status,
				stripeSubscriptionId: organizationBilling.stripeSubscriptionId,
			})
			.from(organizationBilling)
			.where(eq(organizationBilling.organizationId, org.id))
			.limit(1);
		if (row?.status === "active" || row?.status === "trialing") return { kind: "settled", org };
		if (row?.stripeSubscriptionId && row.status === "none") return { kind: "in-flight", org };
		return { kind: "not-started", org };
	} catch (err) {
		log.error("[onboarding] could not resolve setup state", { err });
		return { kind: "unknown" };
	}
}

// ── What onboarding can work out instead of asking ─────────────────────────────────────
//
// The maintainer's bar (2026-11-21): "as little input from the user as possible, as much as we can
// deduce." The trial runs the full purchase gate, so the payer's billing country and capacity must
// be known before it starts. Both are DEDUCED here and shown to the person as editable defaults;
// what they submit is what is declared. Nothing below reads anything stored about another user, and
// nothing below stores or logs a request address: the inputs are a country header, the person's own
// email, their browser's language and their own org's earlier declaration.

/** The ISO 3166-1 alpha-2 codes the country picker offers. A deduction outside it is discarded. */
const KNOWN_COUNTRIES: ReadonlySet<string> = new Set(COUNTRY_OPTIONS.map((c) => c.code));

/**
 * Country-code top-level domains that are sold as generic names (`.io`, `.ai`, `.co` …). An address
 * at one says nothing about where its owner is, so it is never read as a country.
 */
const GENERIC_CC_TLDS: ReadonlySet<string> = new Set([
	"ac", "ai", "cc", "co", "fm", "gg", "io", "is", "la", "ly", "me", "nu", "sc", "sh", "so", "tk",
	"to", "tv", "vc", "ws",
]);

/** Where a deduced billing country came from — shown under the field so the default is explained. */
export type BillingCountrySource = "declared" | "location" | "email" | "language";

/** A deduced billing country and the evidence it came from. */
export interface DeducedCountry {
	/** ISO 3166-1 alpha-2, upper-case. */
	readonly code: string;
	readonly source: BillingCountrySource;
}

/** What {@link deduceBillingCountry} reads, every input optional. */
export interface CountryEvidence {
	/** The org's own earlier declaration (`organization_billing.billing_country`). */
	readonly declared?: string | null;
	/** The request's geolocation country header (Cloudflare's `CF-IPCountry`), as sent. */
	readonly geoCountry?: string | null;
	/** The person's own sign-in email. */
	readonly email?: string | null;
	/** The request's `Accept-Language` header, as sent. */
	readonly acceptLanguage?: string | null;
}

/** Upper-cases `value` and returns it when it is a country the picker offers, else null. */
function knownCountry(value: string | null | undefined): string | null {
	const code = value?.trim().toUpperCase() ?? "";
	return KNOWN_COUNTRIES.has(code) ? code : null;
}

/** The domain of an email address, lower-cased, or "" when there is none. */
function emailDomain(email: string | null | undefined): string {
	if (!email) return "";
	const at = email.lastIndexOf("@");
	if (at < 0) return "";
	return email.slice(at + 1).trim().toLowerCase();
}

/** The country an email domain's country-code TLD names (`acme.de` → `DE`), or null. */
export function countryFromEmail(email: string | null | undefined): string | null {
	const tld = emailDomain(email).split(".").pop() ?? "";
	if (tld.length !== 2 || GENERIC_CC_TLDS.has(tld)) return null;
	// `.uk` is the one ccTLD in use that is not its country's ISO code.
	return knownCountry(tld === "uk" ? "GB" : tld);
}

/** The first region an `Accept-Language` header names (`de-AT,de;q=0.9` → `AT`), or null. */
export function countryFromAcceptLanguage(header: string | null | undefined): string | null {
	for (const part of header?.split(",") ?? []) {
		const tag = part.split(";")[0]?.trim() ?? "";
		const region = tag.split("-").find((sub, i) => i > 0 && /^[A-Za-z]{2}$/.test(sub));
		const code = knownCountry(region);
		if (code) return code;
	}
	return null;
}

/**
 * The billing country to show as the default, and why — or null when nothing says anything.
 *
 * Order: the org's own earlier declaration (a retry after a refused trial must not re-guess what the
 * person already said), then the request's geolocation, then the email domain's country code, then
 * the browser's language region. A value the picker does not offer (Cloudflare's `XX` and `T1`, a
 * typo) is skipped, never shown.
 */
export function deduceBillingCountry(evidence: CountryEvidence): DeducedCountry | null {
	const declared = knownCountry(evidence.declared);
	if (declared) return { code: declared, source: "declared" };
	const located = knownCountry(evidence.geoCountry);
	if (located) return { code: located, source: "location" };
	const fromEmail = countryFromEmail(evidence.email);
	if (fromEmail) return { code: fromEmail, source: "email" };
	const fromLanguage = countryFromAcceptLanguage(evidence.acceptLanguage);
	if (fromLanguage) return { code: fromLanguage, source: "language" };
	return null;
}

/**
 * Mail providers anyone can open an inbox at. An address at one of them says nothing about an
 * employer, so it does not suggest a business purchase. Not exhaustive: an unlisted personal domain
 * reads as a company, and the person turns the switch off — the default is a suggestion, the
 * submitted value is the declaration.
 */
const PERSONAL_MAIL_DOMAINS: ReadonlySet<string> = new Set([
	"163.com", "aol.com", "fastmail.com", "gmail.com", "gmx.at", "gmx.com", "gmx.de", "gmx.net",
	"googlemail.com", "hey.com", "hotmail.co.uk", "hotmail.com", "hotmail.de", "hotmail.fr",
	"icloud.com", "live.com", "mac.com", "mail.com", "mail.ru", "me.com", "msn.com", "outlook.com",
	"outlook.de", "pm.me", "proton.me", "protonmail.com", "qq.com", "t-online.de", "tutanota.com",
	"web.de", "yahoo.co.uk", "yahoo.com", "yahoo.de", "yahoo.fr", "yandex.com", "yandex.ru",
	"zoho.com",
]);

/** Whether an email address is at a personal mail provider rather than an organization's domain. */
export function isPersonalMailDomain(email: string | null | undefined): boolean {
	const domain = emailDomain(email);
	return domain === "" || PERSONAL_MAIL_DOMAINS.has(domain);
}

/**
 * The payer capacity to show as the default: `organization` for an address at a company's own
 * domain, `consumer` otherwise. Shown as one switch the person can turn; what they submit is what
 * `declarePayer` records.
 */
export function suggestedPayerCapacity(email: string | null | undefined): PayerCapacity {
	return isPersonalMailDomain(email) ? "consumer" : "organization";
}
