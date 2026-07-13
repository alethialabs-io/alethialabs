"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The operator plane's mutations — flip an existing org to Enterprise (Flow A) or create a new
// Enterprise org (Flow B). Every mutation: assertPlatformAdmin() (act-capable allowlist, distinct
// from read-only support staff) → withPlatformAudit (committed attempt row + result, required
// reason) → the act. Billing is written through the CONSOLE (set-plan / the Stripe webhook), never
// directly, so organization_billing stays single-writer; org creation goes through the console
// provision-org route, so authz/slug logic stays in the console.

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { enterpriseContract } from "@repo/platform/schema";
import { assertPlatformAdmin } from "@/lib/auth/staff";
import { getServiceDb } from "@/lib/db";
import { withPlatformAudit } from "@/lib/platform/audit";
import { provisionOrg, setOrgPlan } from "@/lib/platform/console-client";
import { getOrgStripeCustomer } from "@/lib/platform/queries";
import { createEnterpriseInvoiceSubscription } from "@/lib/platform/stripe";

const contractFields = z.object({
	seats: z.coerce.number().int().positive().nullable().default(null),
	termMonths: z.coerce.number().int().positive().max(120).default(12),
	collectionMethod: z.enum(["stripe", "external"]),
	amountCents: z.coerce.number().int().nonnegative().nullable().default(null),
	currency: z.string().length(3).default("usd"),
	interval: z.enum(["month", "year"]).default("year"),
	contractRef: z.string().max(200).optional(),
	invoiceRef: z.string().max(200).optional(),
	notes: z.string().max(2000).optional(),
	reason: z.string().min(1, "A reason is required"),
});

const grantSchema = contractFields.extend({ orgId: z.string().uuid(), ownerEmail: z.string().email() });
const createSchema = contractFields.extend({
	name: z.string().min(2).max(120),
	slug: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "lowercase-with-dashes"),
	ownerEmail: z.string().email(),
});

export interface ActionResult {
	ok: boolean;
	error?: string;
	/** For the Stripe path — the hosted invoice URL to hand the customer. */
	invoiceUrl?: string | null;
	/** For Flow B — the created org id. */
	orgId?: string;
}

/** Term end = now + N months, computed on the server. */
function termEnd(months: number): Date {
	const d = new Date();
	d.setMonth(d.getMonth() + months);
	return d;
}

/**
 * Applies an Enterprise plan to an org (writes billing via the console + records the contract).
 * `external` → console set-plan activates immediately. `stripe` → creates an invoiced subscription;
 * the console webhook activates on the events (do NOT write billing here, to keep single-writer).
 */
async function applyEnterprise(
	actor: string,
	orgId: string,
	ownerEmail: string,
	f: z.infer<typeof contractFields>,
): Promise<{ invoiceUrl: string | null }> {
	const db = getServiceDb();
	const start = new Date();
	const end = termEnd(f.termMonths);
	let invoiceUrl: string | null = null;
	let stripeCustomerId: string | null = null;
	let stripeSubscriptionId: string | null = null;

	if (f.collectionMethod === "external") {
		await setOrgPlan({
			orgId,
			plan: "enterprise",
			status: "active",
			seats: f.seats,
			periodEnd: end.toISOString(),
		});
	} else {
		if (f.amountCents == null || f.amountCents <= 0) {
			throw new Error("A positive amount is required for the Stripe path.");
		}
		const existing = await getOrgStripeCustomer(orgId);
		const res = await createEnterpriseInvoiceSubscription({
			orgId,
			ownerEmail,
			amountCents: f.amountCents,
			currency: f.currency,
			interval: f.interval,
			daysUntilDue: 30,
			seats: f.seats,
			existingCustomerId: existing,
			createdBy: actor,
		});
		invoiceUrl = res.invoiceUrl;
		stripeCustomerId = res.customerId;
		stripeSubscriptionId = res.subscriptionId;
	}

	await db.insert(enterpriseContract).values({
		organizationId: orgId,
		plan: "enterprise",
		seats: f.seats,
		termStart: start,
		termEnd: end,
		collectionMethod: f.collectionMethod,
		amountCents: f.amountCents,
		currency: f.currency,
		contractRef: f.contractRef ?? null,
		invoiceRef: f.invoiceRef ?? null,
		notes: f.notes ?? null,
		stripeCustomerId,
		stripeSubscriptionId,
		createdByEmail: actor,
	});

	return { invoiceUrl };
}

/** Flow A — flip an EXISTING org to Enterprise. */
export async function grantEnterprise(form: unknown): Promise<ActionResult> {
	const staff = await assertPlatformAdmin();
	const parsed = grantSchema.safeParse(form);
	if (!parsed.success) {
		return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
	}
	const { orgId, ownerEmail, reason, ...f } = parsed.data;

	try {
		const { invoiceUrl } = await withPlatformAudit(
			staff.email,
			"grant_enterprise",
			orgId,
			reason,
			{
				plan: "enterprise",
				seats: f.seats,
				termMonths: f.termMonths,
				collectionMethod: f.collectionMethod,
				amountCents: f.amountCents,
				currency: f.currency,
				contractRef: f.contractRef,
				invoiceRef: f.invoiceRef,
			},
			() => applyEnterprise(staff.email, orgId, ownerEmail, { ...f, reason }),
		);
		revalidatePath(`/orgs/${orgId}`);
		return { ok: true, invoiceUrl };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : "Grant failed" };
	}
}

/** Flow B — create a NEW org for an Enterprise customer, invite the owner, and set the plan. */
export async function createEnterpriseOrg(form: unknown): Promise<ActionResult> {
	const staff = await assertPlatformAdmin();
	const parsed = createSchema.safeParse(form);
	if (!parsed.success) {
		return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
	}
	const { name, slug, ownerEmail, reason, ...f } = parsed.data;

	try {
		const result = await withPlatformAudit(
			staff.email,
			"create_enterprise_org",
			null,
			reason,
			{ plan: "enterprise", orgName: name, slug, ownerEmail, collectionMethod: f.collectionMethod },
			async () => {
				const { orgId } = await provisionOrg({ name, slug, ownerEmail });
				const { invoiceUrl } = await applyEnterprise(staff.email, orgId, ownerEmail, {
					...f,
					reason,
				});
				return { orgId, invoiceUrl };
			},
		);
		revalidatePath("/orgs");
		return { ok: true, orgId: result.orgId, invoiceUrl: result.invoiceUrl };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : "Creation failed" };
	}
}

