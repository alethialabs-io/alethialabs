"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The org's General-settings WRITES. Name + slug live on the organization row; the rest
// (description, data region, default Project env, Terraform version) live in the org `metadata`
// JSON. The READ is `settings.org` on the read router (lib/rpc/procedures/settings.ts, #6128).
//
// The rename and the delete still go through better-auth's organization plugin — it owns the org
// row, the role check (`organization: ["update"]` / `["delete"]`) and the ee/ hooks that refuse a
// reserved slug and keep the paid create-a-team marker. What changed (#6128) is WHERE they are
// called from: the browser used to call `authClient.organization.update` directly, so nothing
// between the form and the row checked a length (F014), a refusal reached the user as raw validator
// text (F013), and three rapid clicks were three saves (F015). These actions validate the shared
// schema first, answer in the `ActionResult` contract, and dispatch the plugin in-process.

import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
	ORG_SLUG_INVALID_FORMAT_CODE,
	ORG_SLUG_TOO_LONG_CODE,
} from "@repo/org-slug";
import { defineAction } from "@/lib/actions/define-action";
import { ActionRefusal, type ActionResult, FieldRefusal } from "@/lib/actions/result";
import { auth } from "@/lib/auth";
import { UnauthorizedError } from "@/lib/auth/errors";
import { authorize, authorizeInOrg, currentActor } from "@/lib/authz/guard";
import { ForbiddenError } from "@/lib/authz/types";
import { getServiceDb } from "@/lib/db";
import { organization } from "@/lib/db/schema";
import { type OrgPrimaryAddress, withPrimaryAddress } from "@/lib/org/settings";
import { ORG_SLUG_RESERVED_CODE, ORG_SLUG_RESERVED_MESSAGE } from "@/lib/routing";
import { type OrgGeneralValues, orgGeneralSchema } from "@/lib/validations/org-general";

// The by-id read (orgSettingsForOrg) lives in lib/org/settings.ts. It takes an org id and reads
// through the service client with no session, so as an export of this `"use server"` file it
// answered ANY org's name, description and billing address to anyone who could name the id
// (#5219). Its callers — the `settings.org` read procedure and the CLI route — resolve the org first.

/** The sentence for a slug another organization holds — the create-a-team sheet's too. */
const SLUG_TAKEN = "That slug is taken — try another.";

/** better-auth's own code for a slug another organization holds (`/organization/update`). */
const BETTER_AUTH_SLUG_TAKEN = "ORGANIZATION_SLUG_ALREADY_TAKEN";

/** The fields of a better-auth `APIError` body that this file reads. */
const apiErrorBody = z.object({ code: z.string().optional(), message: z.string().optional() });

/** What one in-process call to an organization endpoint came back as. */
type EndpointOutcome =
	| { ok: true }
	| { ok: false; status: number; code: string | undefined; message: string | undefined };

/**
 * Dispatches one of better-auth's organization endpoints through `auth.handler`, as the signed-in
 * caller (their cookies forwarded). The organization plugin is loaded through the ee/ seam, so
 * `auth.api` cannot statically know its endpoints; `auth.handler` is the typed, cast-free
 * dispatcher, and it still runs the plugin's own session, membership and role checks and the ee/
 * organization hooks (`app/server/actions/sso.ts` does the same for the SSO plugin).
 *
 * It does NOT run the `/api/auth` route's pre-checks — the caller must hold the PDP decision that
 * stands in for them (see `saveOrgGeneral` / `deleteOrganization`).
 */
async function callOrganizationEndpoint(
	path: "/organization/update" | "/organization/delete",
	body: unknown,
): Promise<EndpointOutcome> {
	const incoming = await headers();
	const origin = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "http://localhost:3000";
	const forwarded = new Headers(incoming);
	forwarded.set("content-type", "application/json");
	const res = await auth.handler(
		new Request(`${origin}/api/auth${path}`, {
			method: "POST",
			headers: forwarded,
			body: JSON.stringify(body),
		}),
	);
	if (res.ok) return { ok: true };
	const parsed = apiErrorBody.safeParse(await res.json().catch(() => null));
	return {
		ok: false,
		status: res.status,
		code: parsed.success ? parsed.data.code : undefined,
		message: parsed.success ? parsed.data.message : undefined,
	};
}

/**
 * Turns a refused organization-endpoint call into the error the action answers with. The slug's
 * refusals go under the slug FIELD (the form shows them inline); a missing session is a sign-in; a
 * role refusal is `forbidden`; anything else the plugin answered is a failure whose text is NOT
 * shown — it goes through `defineAction`'s unexpected path and is logged with a reference.
 */
function refusalFor(outcome: Exclude<EndpointOutcome, { ok: true }>): Error {
	switch (outcome.code) {
		case BETTER_AUTH_SLUG_TAKEN:
			return new FieldRefusal({ slug: [SLUG_TAKEN] }, SLUG_TAKEN);
		case ORG_SLUG_RESERVED_CODE:
			return new FieldRefusal({ slug: [ORG_SLUG_RESERVED_MESSAGE] }, ORG_SLUG_RESERVED_MESSAGE);
		case ORG_SLUG_INVALID_FORMAT_CODE:
		case ORG_SLUG_TOO_LONG_CODE: {
			const message = outcome.message ?? "Lowercase letters, numbers and hyphens.";
			return new FieldRefusal({ slug: [message] }, message);
		}
	}
	if (outcome.status === 401) return new UnauthorizedError();
	if (outcome.status === 403) return new ForbiddenError("edit", { type: "org" });
	return new Error(
		`organization endpoint refused (${outcome.status} ${outcome.code ?? "no code"}): ${outcome.message ?? ""}`,
	);
}

/** The org's metadata JSON as stored, or `{}` — every key the settings form does not edit is kept. */
async function storedMetadata(orgId: string): Promise<Record<string, unknown>> {
	const [row] = await getServiceDb()
		.select({ metadata: organization.metadata })
		.from(organization)
		.where(eq(organization.id, orgId))
		.limit(1);
	if (!row) throw new ActionRefusal("not-found", "This organization no longer exists.");
	if (!row.metadata) return {};
	try {
		const parsed: unknown = JSON.parse(row.metadata);
		return z.record(z.string(), z.unknown()).catch({}).parse(parsed);
	} catch {
		return {};
	}
}

/** What a successful General-settings save answers: the values as stored. */
export interface OrgGeneralSaved {
	name: string;
	slug: string;
}

/**
 * Saves the addressed org's General settings (name, slug, description, data region, default
 * environment, Terraform version) — the org the page's ADDRESS names, never one the client sends.
 *
 * The PDP's `edit` on the org runs first: it refuses a viewer or operator before anything is
 * written, AND a member whose membership is not active — the `/api/auth` route refuses those
 * before better-auth runs (#5472), and this in-process dispatch does not pass through that route.
 *
 * The metadata keeps every stored key the form does not edit (the billing-derived primary address,
 * the paid create-a-team marker — which the ee/ update hook also rewrites from storage), so a save
 * can never drop one.
 */
export async function saveOrgGeneral(
	raw: z.input<typeof orgGeneralSchema>,
): Promise<ActionResult<OrgGeneralSaved>> {
	return defineAction({
		input: orgGeneralSchema,
		run: ({ input }) => writeOrgGeneral(input),
	})(raw);
}

/** The body of {@link saveOrgGeneral}, once its input has been validated. */
async function writeOrgGeneral(input: OrgGeneralValues): Promise<OrgGeneralSaved> {
	const actor = await currentActor();
	if (actor.orgId === actor.userId) {
		throw new ActionRefusal("not-found", "The personal workspace has no organization settings.");
	}
	await authorize("edit", { type: "org" });
	const metadata = {
		...(await storedMetadata(actor.orgId)),
		description: input.description,
		region: input.region,
		defaultEnv: input.defaultEnv,
		terraformVersion: input.terraformVersion,
	};
	const outcome = await callOrganizationEndpoint("/organization/update", {
		organizationId: actor.orgId,
		data: { name: input.name, slug: input.slug, metadata },
	});
	if (!outcome.ok) throw refusalFor(outcome);
	return { name: input.name, slug: input.slug };
}

/**
 * Deletes the addressed org. The PDP's `edit` on the org runs first (it refuses a member whose
 * membership is not active, as the `/api/auth` route does); better-auth then holds deletion to the
 * org's owner.
 */
export async function deleteOrganization(raw: Record<string, never>): Promise<ActionResult<{ deleted: true }>> {
	return defineAction({
		input: z.object({}).strict(),
		run: () => removeOrganization(),
	})(raw);
}

/** The body of {@link deleteOrganization}. */
async function removeOrganization(): Promise<{ deleted: true }> {
	const actor = await currentActor();
	if (actor.orgId === actor.userId) {
		throw new ActionRefusal("not-found", "The personal workspace can't be deleted.");
	}
	await authorize("edit", { type: "org" });
	const outcome = await callOrganizationEndpoint("/organization/delete", {
		organizationId: actor.orgId,
	});
	if (!outcome.ok) throw refusalFor(outcome);
	return { deleted: true };
}

/**
 * Stores an org's primary address in its metadata JSON — set from the checkout form when "Use the
 * billing address as my team's primary address" is checked. Merged into the existing metadata.
 *
 * @param orgId the org to write to, when it is not the ambient one. NAMED for the same reason
 * `startProTrial` and `linkSubscriptionToNewOrg` are: the create-org sheet runs from a page inside
 * the CURRENT org and then writes to the org it has just created, so under URL-wins the ambient org
 * is the wrong one — ticking "use as my primary address" while creating a team from `/acme/…`
 * silently overwrote ACME's primary address, and the caller's `catch {}` meant nothing surfaced.
 * Optional because `upgrade-org-sheet` and `onboarding-form` genuinely mean the ambient org.
 *
 * It is still never client-supplied in the ambient case — an id passed here is authorized through
 * `authorizeInOrg`, which refuses an org the caller is not scoped to.
 */
export async function updateOrgPrimaryAddress(
	address: OrgPrimaryAddress,
	orgId?: string,
): Promise<{ ok: true }> {
	const actor = orgId
		? await authorizeInOrg("manage_billing", { type: "billing" }, orgId)
		: await currentActor();
	if (actor.orgId === actor.userId) {
		throw new Error("No organization in scope.");
	}
	const db = getServiceDb();
	const [org] = await db
		.select({ metadata: organization.metadata })
		.from(organization)
		.where(eq(organization.id, actor.orgId))
		.limit(1);
	// Every other key in the blob is kept as stored (`withPrimaryAddress`) — this is a direct write, so
	// the organization plugin's update hook that guards the create-a-team marker never sees it.
	await db
		.update(organization)
		.set({ metadata: withPrimaryAddress(org?.metadata ?? null, address), updatedAt: new Date() })
		.where(eq(organization.id, actor.orgId));
	return { ok: true };
}
