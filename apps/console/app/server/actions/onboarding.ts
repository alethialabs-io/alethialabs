"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Server actions for the post-signup /onboarding setup flow. The org plugin is
// EE-gated and not loaded in the community build, so we configure the
// auto-provisioned primary org by writing the `organization` table directly
// (mirroring provisionPrimaryOrg) rather than via authClient.organization.*.

import { and, count, eq, ne } from "drizzle-orm";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { startProTrial } from "@/app/server/actions/billing";
import { acceptLegalDocuments, declarePayer } from "@/app/server/actions/legal";
import { setActiveOrganization } from "@/app/server/actions/workspace";
import {
	ACCEPTANCE_LOCALE,
	ACCEPTED_DOCUMENTS,
	requiredMessage,
} from "@/components/legal/terms-acceptance-copy";
import { defineAction } from "@/lib/actions/define-action";
import { ActionRefusal, FieldRefusal, type ActionResult } from "@/lib/actions/result";
import { UnauthorizedError } from "@/lib/auth/errors";
import {
	completeOnboarding,
	getPrimaryOrg,
	resolveOnboarding,
} from "@/lib/auth/onboarding";
import { getOwner } from "@/lib/auth/owner";
import { currentActor } from "@/lib/authz/guard";
import { getEntitlements } from "@/lib/authz/entitlements";
import {
	hasAcceptedCurrentDocuments,
	PaidConversionNotAllowedError,
} from "@/lib/billing/eligibility";
import { isUsStateCode } from "@/lib/billing/tax-ids";
import { getServiceDb } from "@/lib/db";
import {
	cloudIdentities,
	jobs,
	member,
	organization,
	projects,
} from "@/lib/db/schema";
import { log } from "@/lib/observability/log";
import { RESERVED_SLUGS } from "@/lib/routing";
import { orgSlugShapeRefusal } from "@repo/org-slug";

/**
 * {@link configureOnboardingOrg}'s result: the persisted slug, or a refusal the user can read.
 *
 * A refusal is RETURNED, not thrown, because this is a `"use server"` export: in a production build
 * (`next build` + `next start`, which the `qa` release-gate leg drives) Next redacts a thrown
 * `Error`'s message to a digest and answers HTTP 500, so "That slug is reserved" never reached the
 * form — the #4644 class, fixed for `projects.ts` and missed here (#5415). Only refusals the user
 * can act on (name, slug format, reserved, taken) travel this way; an unauthenticated caller, a
 * missing org or a non-owner still throw, because the onboarding form cannot fix any of those.
 */
export type ConfigureOnboardingOrgResult =
	| { ok: true; slug: string }
	| { ok: false; error: string };

/**
 * Renames the current user's primary organization and sets its URL slug (the
 * "Create your organization" step of /onboarding). Owner-gated; validates the slug
 * format and global uniqueness, treating the org's own current slug as available.
 * Returns the persisted slug, or a readable refusal (see {@link ConfigureOnboardingOrgResult}).
 */
export async function configureOnboardingOrg(input: {
	name: string;
	slug: string;
}): Promise<ConfigureOnboardingOrgResult> {
	const userId = await getOwner();
	if (!userId) throw new Error("Not authenticated");

	const org = await getPrimaryOrg(userId);
	if (!org) throw new Error("No organization to configure.");
	if (org.role !== "owner") {
		throw new Error("Only the organization owner can configure it.");
	}

	const name = input.name.trim();
	const slug = input.slug.trim().toLowerCase();
	if (name.length < 2) {
		return { ok: false, error: NAME_REFUSAL };
	}
	// The one org-slug rule (@repo/org-slug), which names which half failed: a 64-character slug
	// told "use lowercase letters" has nothing to fix.
	const shape = orgSlugShapeRefusal(slug);
	if (shape) {
		return { ok: false, error: shape.message };
	}
	if (RESERVED_SLUGS.has(slug)) {
		return { ok: false, error: "That slug is reserved — try another." };
	}

	// Unique across all orgs except this one (the user keeps their own slug).
	const [taken] = await getServiceDb()
		.select({ id: organization.id })
		.from(organization)
		.where(and(eq(organization.slug, slug), ne(organization.id, org.id)))
		.limit(1);
	if (taken) return { ok: false, error: "That slug is taken — try another." };

	await getServiceDb()
		.update(organization)
		.set({ name, slug, updatedAt: new Date() })
		.where(eq(organization.id, org.id));

	return { ok: true, slug };
}

/** The one refusal of {@link configureOnboardingOrg} that is about the NAME; every other is about the slug. */
const NAME_REFUSAL = "Give your organization a name.";

/** What onboarding submits: the org, the plan, the terms the person ticked, and — for Pro — the payer. */
const finishOnboardingInput = z.object({
	name: z.string().max(200),
	slug: z.string().max(200),
	plan: z.enum(["community", "team"]),
	/**
	 * The documents the checkbox the person ticked named, each at the version it printed. Empty when no
	 * box was shown. The server decides what must be accepted; this only lets it refuse an acceptance
	 * of a version the page did not show (a document sealed while the page was open).
	 */
	acceptedDocuments: z
		.array(z.object({ id: z.string().min(1).max(64), version: z.string().min(1).max(64) }))
		.max(16),
	/** The browser's own clock, recorded beside the server's with the acceptance. Untrusted. */
	clientTimestamp: z.string().datetime().nullable(),
	/** The payer facts the purchase gate reads before the trial starts. Required for `team`. */
	payer: z
		.object({
			capacity: z.enum(["consumer", "organization"]),
			billingCountry: z.string().trim().length(2),
			authorityAttestation: z.string().trim().max(200).nullable(),
			/**
			 * The Early Access facts (#7324): whether a business has a VAT number (and which), and a US
			 * payer's state. Optional so an older tab still parses; the purchase gate then refuses an EU
			 * business or a US payer as undeclared, and the form says which field to fill.
			 */
			vatIdStatus: z.enum(["given", "not_given"]).nullable().optional(),
			vatId: z.string().trim().max(32).nullable().optional(),
			billingState: z.string().trim().max(2).nullable().optional(),
		})
		.nullable(),
});

/** What the onboarding form sends to {@link finishOnboarding}. */
export type FinishOnboardingInput = z.input<typeof finishOnboardingInput>;

/** What a finished onboarding hands back: the org's slug, for the destination `/{slug}/~/new`. */
export interface FinishOnboardingResult {
	slug: string;
}

/** Said when the org already has a payment that has not been confirmed. */
const IN_FLIGHT_REFUSAL =
	"A subscription payment for this organization is still being confirmed. Reload this page in a minute.";

/** Said when a trial could not start for a reason that is not the purchase gate's. */
const TRIAL_FAILED =
	"We couldn't start your Pro trial. Your organization is saved — choose Hobby to continue, or try again.";

/** Said when the box was not ticked, or ticked for a version that is no longer current. */
const TERMS_CHANGED =
	"Our Terms changed while this page was open. Reload the page to read the current version.";

/**
 * Finishes post-signup setup in ONE server call (WIZ-W6, #6929): names the primary org, records the
 * terms acceptance the inline checkbox gave, and — on Pro — declares the payer and starts the
 * card-less trial, then marks setup complete. Through the mutation contract, so every refusal reaches
 * the form as a value, under the field it is about.
 *
 * WHY ONE CALL, IN THIS ORDER. The form used to make four calls of its own and mark completion last
 * from the browser, so a reload between them showed the plan chooser again. Here:
 *   1. `resolveOnboarding` first. A setup the server already considers finished (`complete`, or a
 *      live plan with only the completion write missing) is finished again, idempotently, and starts
 *      nothing — a second tab, or Back after finishing, cannot start a second trial.
 *   2. Every check that writes nothing (the terms box, the payer facts) before the first write.
 *   3. The org's name and slug, then the acceptance through `acceptLegalDocuments`, exactly as the
 *      `/accept-terms` page records it.
 *   4. Pro: the payer facts go on the org's billing row through `declarePayer` — the same writer the
 *      upgrade sheet uses — and only then `startProTrial`, so the purchase gate it runs reads the
 *      facts just declared. A refused or failed trial leaves setup NOT complete and says why; the
 *      org stays named, the acceptance stays recorded, and choosing Hobby finishes.
 *   5. Completion last. If that write is lost after a trial started, `resolveOnboarding` reads the
 *      live plan on the next load and finishes it (`settled`).
 *
 * The session's active org is set here, server-side, instead of from a mount effect in the form;
 * the trial and the payer facts name the org explicitly, so neither depends on it.
 */
export async function finishOnboarding(
	raw: FinishOnboardingInput,
): Promise<ActionResult<FinishOnboardingResult>> {
	return defineAction({ input: finishOnboardingInput, run: ({ input }) => runFinishOnboarding(input) })(
		raw,
	);
}

/** The body of {@link finishOnboarding}, on parsed input. */
async function runFinishOnboarding(
	input: z.output<typeof finishOnboardingInput>,
): Promise<FinishOnboardingResult> {
	const userId = await getOwner();
	if (!userId) throw new UnauthorizedError();

	const state = await resolveOnboarding(userId);
	switch (state.kind) {
		case "complete": {
			const org = await getPrimaryOrg(userId);
			return { slug: org?.slug ?? "" };
		}
		case "settled":
			await completeOnboarding(userId);
			return { slug: state.org.slug };
		case "in-flight":
			throw new ActionRefusal("conflict", IN_FLIGHT_REFUSAL);
		case "no-org":
			throw new ActionRefusal(
				"not-found",
				"Your organization could not be set up. Reload the page to try again.",
			);
		case "unknown":
			throw new Error("onboarding state could not be read");
		case "not-started":
			break;
	}
	const org = state.org;
	if (org.role !== "owner") {
		throw new ActionRefusal("conflict", "Only the organization's owner can finish its setup.");
	}

	// The terms box: required whenever the current documents are not all accepted, and only for the
	// versions the page printed. Asked before any write, so an unticked box changes nothing.
	const termsPending = !(await hasAcceptedCurrentDocuments(userId));
	if (termsPending) {
		const shown = new Map(input.acceptedDocuments.map((d) => [d.id, d.version]));
		if (shown.size === 0) {
			throw new FieldRefusal(
				{ acceptTerms: [requiredMessage(ACCEPTED_DOCUMENTS.map(asAcceptanceDocument))] },
				"Accept the Terms to continue.",
			);
		}
		if (ACCEPTED_DOCUMENTS.some((d) => shown.get(d.id) !== d.version)) {
			throw new FieldRefusal({ acceptTerms: [TERMS_CHANGED] }, TERMS_CHANGED);
		}
	}

	const payer = input.plan === "team" ? checkedPayer(input.payer) : null;

	const identity = await configureOnboardingOrg({ name: input.name, slug: input.slug });
	if (!identity.ok) {
		const field = identity.error === NAME_REFUSAL ? "name" : "slug";
		throw new FieldRefusal({ [field]: [identity.error] }, identity.error);
	}

	if (termsPending) {
		await acceptLegalDocuments({
			documentIds: ACCEPTED_DOCUMENTS.map((d) => d.id),
			locale: ACCEPTANCE_LOCALE,
			clientTimestamp: input.clientTimestamp,
		});
	}

	await setActiveOrganization(org.id);

	if (payer) {
		await declarePayerOrRefuse(payer, org.id);
		await startTrialOrRefuse(org.id);
	}

	await completeOnboarding(userId);
	return { slug: identity.slug };
}

/**
 * The payer facts a Pro trial needs, checked before anything is written: present, a two-letter
 * country, and an attestation exactly when the payer is an organization. Each refusal names the
 * form field it is about.
 */
function checkedPayer(payer: z.output<typeof finishOnboardingInput>["payer"]): {
	capacity: "consumer" | "organization";
	billingCountry: string;
	authorityAttestation: string | null;
	vatIdStatus: "given" | "not_given" | null;
	vatId: string | null;
	billingState: string | null;
} {
	if (!payer) {
		throw new FieldRefusal(
			{ billingCountry: ["Select the country this organization is billed in."] },
			"Select the country this organization is billed in.",
		);
	}
	const role = payer.authorityAttestation ?? "";
	if (payer.capacity === "organization" && role.length < 2) {
		throw new FieldRefusal(
			{ role: ["Say what your role is — a purchase for a company needs someone who can act for it."] },
			"Say what your role is.",
		);
	}
	const country = payer.billingCountry.toUpperCase();
	const business = payer.capacity === "organization";
	const vatIdStatus = business ? (payer.vatIdStatus ?? null) : null;
	const vatId = vatIdStatus === "given" ? (payer.vatId?.trim() ?? "") : "";
	if (vatIdStatus === "given" && vatId.length === 0) {
		throw new FieldRefusal(
			{ vatId: ["Enter the organization's VAT number."] },
			"Enter the organization's VAT number.",
		);
	}
	const state = country === "US" ? (payer.billingState?.trim().toUpperCase() ?? "") : "";
	if (country === "US" && !isUsStateCode(state)) {
		throw new FieldRefusal(
			{ billingState: ["Select the US state this organization is billed in."] },
			"Select the US state this organization is billed in.",
		);
	}
	return {
		capacity: payer.capacity,
		billingCountry: country,
		authorityAttestation: business ? role : null,
		vatIdStatus,
		vatId: vatId.length > 0 ? vatId : null,
		billingState: state.length > 0 ? state : null,
	};
}

/**
 * Records the payer facts on `orgId`, turning a declaration the writer refuses (a malformed VAT
 * number, one VIES does not list) into a refusal under the VAT-number field. `declarePayer` refuses
 * with a plain `Error` whose sentence is written for the customer; anything that is not a refusal —
 * an authorization failure, a database error — is rethrown.
 */
async function declarePayerOrRefuse(
	payer: ReturnType<typeof checkedPayer>,
	orgId: string,
): Promise<void> {
	try {
		await declarePayer(payer, { orgId });
	} catch (err) {
		unstable_rethrow(err);
		if (payer.vatIdStatus === "given" && err instanceof Error && /VAT number/.test(err.message)) {
			throw new FieldRefusal({ vatId: [err.message] }, err.message);
		}
		throw err;
	}
}

/**
 * Starts the card-less trial on `orgId`, turning a refusal into one the form can show. The purchase
 * gate's refusal is shown in its own words (it names what to do); anything else is logged with a
 * reference and shown as one sentence that says the org is saved.
 */
async function startTrialOrRefuse(orgId: string): Promise<void> {
	try {
		await startProTrial({ orgId });
	} catch (err) {
		unstable_rethrow(err);
		if (err instanceof PaidConversionNotAllowedError) {
			throw new ActionRefusal("conflict", err.message);
		}
		const ref = crypto.randomUUID().slice(0, 8);
		log.error(`[onboarding] trial did not start ref=${ref}`, { ref, err });
		throw new ActionRefusal("conflict", `${TRIAL_FAILED} Reference: ${ref}`);
	}
}

/** A sealed document as the copy module's `AcceptanceDocument` shape, for its required message. */
function asAcceptanceDocument(doc: (typeof ACCEPTED_DOCUMENTS)[number]) {
	return { id: doc.id, title: doc.title, version: doc.version, path: doc.path, firstAcceptance: true };
}

/**
 * Marks the current user's post-signup setup (/onboarding) as finished so the
 * post-login gate stops routing them back into it. Called from the wizard's
 * final step (and when they skip ahead to the console).
 */
export async function markOnboardingComplete(): Promise<void> {
	const userId = await getOwner();
	if (!userId) throw new Error("Not authenticated");
	await completeOnboarding(userId);
}

/** Real-data progress for the in-product "Get started" first-run checklist. */
export interface GettingStartedState {
	hasCloud: boolean;
	hasProject: boolean;
	/** A project has been provisioned at least once (a DEPLOY job succeeded). */
	hasProvisioned: boolean;
	/** Inviting teammates is a paid (Pro+) entitlement. */
	canInvite: boolean;
	/** Active members in the org (>1 means a teammate has joined). */
	memberCount: number;
}

/**
 * Derives the "Get started" checklist completion from the active org's real state —
 * connected clouds, projects, members — so steps tick off as the user actually
 * does them (Stripe-style), rather than tracking a wizard.
 */
export async function getGettingStartedState(): Promise<GettingStartedState> {
	const actor = await currentActor();
	const orgId = actor.orgId;
	const db = getServiceDb();
	const [ci, sp, dep, mc] = await Promise.all([
		// Only a *verified* cloud counts as "connected" — a pending/failed placeholder (initIdentity
		// pre-creates one per provider just by viewing the connectors page) must not tick the step.
		db
			.select({ n: count() })
			.from(cloudIdentities)
			.where(
				and(
					eq(cloudIdentities.org_id, orgId),
					eq(cloudIdentities.is_verified, true),
				),
			),
		db.select({ n: count() }).from(projects).where(eq(projects.org_id, orgId)),
		// Ever provisioned: a deploy job that reached SUCCESS (permanent record —
		// still counts even if the environment was later destroyed).
		db
			.select({ n: count() })
			.from(jobs)
			.where(
				and(
					eq(jobs.org_id, orgId),
					eq(jobs.status, "SUCCESS"),
					eq(jobs.job_type, "DEPLOY"),
				),
			),
		db
			.select({ n: count() })
			.from(member)
			.where(eq(member.organizationId, orgId)),
	]);
	return {
		hasCloud: (ci[0]?.n ?? 0) > 0,
		hasProject: (sp[0]?.n ?? 0) > 0,
		hasProvisioned: (dep[0]?.n ?? 0) > 0,
		canInvite: getEntitlements(actor).organizations,
		memberCount: mc[0]?.n ?? 0,
	};
}
