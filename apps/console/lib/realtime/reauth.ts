// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { actorWithCredential } from "@/lib/authz/actor-credential";
import "server-only";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { EditionMisconfiguredError } from "@/lib/auth/errors";
import { getActiveScope, tenancyMode } from "@/lib/auth/scope";
import { getPdp } from "@/lib/authz";
import type { Actor } from "@/lib/authz/types";
import { deploymentMode } from "@/lib/billing/config";
import { hasAcceptedCurrentDocuments } from "@/lib/billing/eligibility";
import { getServiceDb } from "@/lib/db";
import { member } from "@/lib/db/schema";
import type { StreamCapabilities } from "./routing";
import type { RevokedReason } from "./topics";

// Re-authorising an OPEN stream (#6115, ADR 0005 §10 R7) — the second tenancy path, and why it is one.
//
// The connect path is `currentActor()`, the same as every other request. It cannot run here: it reads
// the request's `headers()` and memoises through React `cache()`, and a 60-second timer inside a
// streaming response has neither a request scope nor a render pass. So this asks the same four
// questions from what the stream SNAPSHOTTED at connect — the cookie, the user, and the org the
// address named — against the database:
//
//   1. is the session behind the cookie still live, and still this user?   → else "unauthorized"
//   2. is the user still an ACTIVE member of the addressed org?              → else "not-member"
//      (the same join `urlScopedOrgId` makes, lib/authz/org-scope.ts; not asked of `~`, the personal
//      scope, which has no member row)
//   3. are the current Terms accepted?                                       → else "terms"
//   4. does the scope resolver still land on that org?                       → else "not-member"
//      (the three arms of `currentActor()`, lib/authz/guard.ts: the org itself; the personal scope
//      only in the single-tenant edition by configuration; an unconfigured edition throws)
//
// KEEP THIS IN STEP WITH `currentActor()` + `urlScopedOrgId()`: a rule added there belongs here too,
// so an open stream is held to the same rules as a fresh connect.
// tests/lib/realtime/reauth.test.ts drives each arm.
//
// A lookup that FAILS throws; it is never reported as a revocation (the client would stop for good
// over a database blip) and never as a pass. The route ends the stream without a `revoked` event, and
// the client's reconnect goes through the connect path from scratch.

/** What a stream captured at connect, and all the re-authorisation reads. */
export interface StreamSnapshot {
	userId: string;
	/** The org the address named: an org id, or the user's own id for `~`. */
	addressOrgId: string;
	/** The request's Cookie header, verbatim. Held in memory only, for the stream's lifetime. */
	cookie: string;
}

/** A re-authorisation's answer. */
export type ReauthResult =
	| { ok: true; actor: Actor; caps: StreamCapabilities }
	| { ok: false; reason: RevokedReason };

/**
 * What a stream may hear beyond its own org and rows. Asked of the PDP with `can`, never `enforce`
 * (no activity entry for a stream opening). A PDP error is a NO — the stream hears less, not more.
 */
export async function capabilitiesOf(actor: Actor): Promise<StreamCapabilities> {
	const pdp = getPdp();
	const ask = async (check: Promise<{ allowed: boolean }>): Promise<boolean> => {
		try {
			return (await check).allowed;
		} catch {
			return false;
		}
	};
	const [platformView, manageSupport, viewAlerts, memberView, viewActivity] = await Promise.all([
		// `platform` carries managed runners and warm pools. The stream hears them exactly when the reads
		// show them (lib/rpc/procedures/runners.ts): on a self-managed deployment, to an actor who may
		// `view` runners — the pool cards and the managed rows are both read on that permission. On the
		// hosted SaaS they are read for nobody, so they are heard by nobody (#6123).
		deploymentMode() === "self-managed" ? ask(pdp.can(actor, "view", { type: "runner" })) : false,
		ask(pdp.can(actor, "manage_support", { type: "support_case" })),
		ask(pdp.can(actor, "view_alerts", { type: "alert" })),
		ask(pdp.can(actor, "view", { type: "member" })),
		// The Activity log's hints go to `view_activity` holders only (#6129) — what `activity.page`
		// answers. `can()` records nothing, so asking adds no row to the log it is about.
		ask(pdp.can(actor, "view_activity", { type: "activity" })),
	]);
	return { platformView, manageSupport, viewAlerts, memberView, viewActivity };
}

/** Is `userId` an ACTIVE member of `orgId`? */
async function isActiveMember(userId: string, orgId: string): Promise<boolean> {
	const [row] = await getServiceDb()
		.select({ id: member.id })
		.from(member)
		.where(
			and(
				eq(member.organizationId, orgId),
				eq(member.userId, userId),
				eq(member.status, "active"),
			),
		)
		.limit(1);
	return row !== undefined;
}

/** Re-asks the connect path's questions for an open stream. Throws when a lookup fails. */
export async function reauthorize(snapshot: StreamSnapshot): Promise<ReauthResult> {
	const { userId, addressOrgId, cookie } = snapshot;

	const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
	if (!session?.user || session.user.id !== userId) {
		return { ok: false, reason: "unauthorized" };
	}

	const personal = addressOrgId === userId;
	if (!personal && !(await isActiveMember(userId, addressOrgId))) {
		return { ok: false, reason: "not-member" };
	}

	if (!(await hasAcceptedCurrentDocuments(userId))) {
		return { ok: false, reason: "terms" };
	}

	const actor = actorWithCredential(await getActiveScope(userId, addressOrgId), "session");
	if (actor.orgId !== addressOrgId) {
		const collapsedToPersonal = actor.orgId === userId;
		const mode = collapsedToPersonal ? tenancyMode() : null;
		if (mode === "unconfigured") throw new EditionMisconfiguredError();
		if (mode !== "single-tenant") return { ok: false, reason: "not-member" };
	}

	return { ok: true, actor, caps: await capabilitiesOf(actor) };
}
