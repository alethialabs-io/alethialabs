// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// "Download my data": the access and portability rights, answered from the account settings.
//
// What a person receives is ONE JSON file:
//
//   { "manifest": { …signed manifest… }, "archive": "<the archive, as a JSON string>" }
//
// The archive is itself JSON — `{ format, generatedAt, files: { "<path>": "<file contents>" } }` —
// carried as a STRING so its exact bytes survive the envelope: the manifest's `archiveSha256` is
// the SHA-256 of that string's UTF-8 bytes, and each part's `sha256` the digest of its file's
// contents, so a recipient can check what they hold without trusting us (`lib/privacy/manifest.ts`
// says how). The manifest is signed with `PRIVACY_EXPORT_SIGNING_KEY` (an ed25519 PEM) when the
// deployment has one, and says honestly that it is unsigned when it does not.
//
// The file is stored in object storage under the case's id and reached only through
// `/api/privacy/export/<reference>?t=<token>`, which requires the SAME signed-in account, the
// emailed token and an unexpired case. The sweep deletes the object when the link expires.
//
// What is in it is the account's own data, read on the service connection: profile, sign-in
// methods (never their tokens or password hash), sessions, memberships, accepted terms, AI
// conversations, and the account's privacy requests. Organization data — projects,
// environments, state — belongs to the organization, whose admins export it; it is not here.

import "server-only";
import { and, desc, eq, isNotNull, lte, or } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import {
	account,
	agentThreads,
	legalAcceptance,
	member,
	organization,
	privacyCase,
	session,
	user,
} from "@/lib/db/schema";
import { storage } from "@/lib/storage";
import type { PrivacyExportManifest } from "@/types/jsonb.types";
import { newReference, recordEvent, subjectHash } from "@/app/server/actions/privacy/ledger";
import { PRIVACY_RESPONSE_DAYS } from "@/app/server/actions/privacy/response-period";
import { sendDataExportReadyEmail } from "./emails";
import { hashLinkToken, mintLinkToken } from "./link-token";
import { buildManifest, type ExportPart, signManifest } from "./manifest";

/** The bucket exports are written to. */
export const PRIVACY_EXPORT_BUCKET = "privacy-exports";

/** How long a download link works, in hours. */
export const EXPORT_LINK_HOURS = 72;

/** The archive's format tag, so a later reader knows which layout it holds. */
const FORMAT = "alethia-data-export/1";

/** The object key of a case's export. */
export function exportObjectKey(caseId: string): string {
	return `${caseId}.json`;
}

/** One file of the archive, before it is hashed. */
interface ExportFile {
	path: string;
	describes: string;
	rows: unknown[];
}

/** Serialises a part's rows: pretty JSON, so the person can read it without a tool. */
function fileContents(rows: unknown[]): string {
	return `${JSON.stringify(rows, null, 2)}\n`;
}

/** Reads every file of the account's archive. */
export async function collectExportFiles(userId: string, subjectEmailSha256: string): Promise<ExportFile[]> {
	const db = getServiceDb();
	const profile = await db
		.select({
			id: user.id,
			name: user.name,
			email: user.email,
			image: user.image,
			createdAt: user.createdAt,
		})
		.from(user)
		.where(eq(user.id, userId));
	const signIn = await db
		.select({
			providerId: account.providerId,
			accountId: account.accountId,
			scope: account.scope,
			createdAt: account.createdAt,
		})
		.from(account)
		.where(eq(account.userId, userId));
	const sessions = await db
		.select({
			createdAt: session.createdAt,
			expiresAt: session.expiresAt,
			ipAddress: session.ipAddress,
			userAgent: session.userAgent,
		})
		.from(session)
		.where(eq(session.userId, userId));
	const memberships = await db
		.select({
			organization: organization.name,
			slug: organization.slug,
			role: member.role,
			status: member.status,
			joinedAt: member.createdAt,
		})
		.from(member)
		.innerJoin(organization, eq(organization.id, member.organizationId))
		.where(eq(member.userId, userId));
	const acceptances = await db
		.select({
			documentId: legalAcceptance.documentId,
			documentVersion: legalAcceptance.documentVersion,
			documentHash: legalAcceptance.documentHash,
			locale: legalAcceptance.locale,
			acceptedAt: legalAcceptance.acceptedAt,
		})
		.from(legalAcceptance)
		.where(eq(legalAcceptance.userId, userId));
	const threads = await db
		.select({
			title: agentThreads.title,
			kind: agentThreads.kind,
			status: agentThreads.status,
			messages: agentThreads.messages,
			createdAt: agentThreads.created_at,
		})
		.from(agentThreads)
		.where(eq(agentThreads.user_id, userId))
		.orderBy(desc(agentThreads.created_at));
	const requests = await db
		.select({
			reference: privacyCase.reference,
			kind: privacyCase.kind,
			state: privacyCase.state,
			receivedAt: privacyCase.receivedAt,
			dueAt: privacyCase.dueAt,
			decidedAt: privacyCase.decidedAt,
		})
		.from(privacyCase)
		.where(
			or(
				eq(privacyCase.subjectUserId, userId),
				eq(privacyCase.subjectEmailSha256, subjectEmailSha256),
			),
		);

	return [
		{ path: "account/profile.json", describes: "Your account: name, address, avatar and when it was created.", rows: profile },
		{ path: "account/sign-in-methods.json", describes: "The sign-in methods linked to your account. Tokens and password hashes are never included.", rows: signIn },
		{ path: "account/sessions.json", describes: "Your active sign-in sessions, with the network address and browser each started from.", rows: sessions },
		{ path: "organizations/memberships.json", describes: "The teams you belong to and your role in each.", rows: memberships },
		{ path: "legal/acceptances.json", describes: "Which versions of our terms you accepted, and when.", rows: acceptances },
		{ path: "ai/conversations.json", describes: "Your conversations with the Alethia agent, newest first.", rows: threads },
		{ path: "privacy/requests.json", describes: "The privacy requests you made, including this one.", rows: requests },
	];
}

/** The built export: the bytes to store and the manifest to record on the case. */
export interface BuiltExport {
	bytes: Uint8Array;
	manifest: PrivacyExportManifest;
}

/**
 * Assembles the downloadable file from its parts — pure, so the format can be tested exactly.
 *
 * `signingKey` is passed in; this function never reads the environment.
 */
export function assembleExport(
	files: ExportFile[],
	generatedAt: Date,
	signingKey: { pem: string; id: string } | null,
): BuiltExport {
	const encoder = new TextEncoder();
	const contents = files.map((f) => ({ ...f, text: fileContents(f.rows) }));
	const archive = JSON.stringify({
		format: FORMAT,
		generatedAt: generatedAt.toISOString(),
		files: Object.fromEntries(contents.map((f) => [f.path, f.text])),
	});
	const archiveBytes = encoder.encode(archive);
	const parts: ExportPart[] = contents.map((f) => ({
		path: f.path,
		describes: f.describes,
		rows: f.rows.length,
		content: encoder.encode(f.text),
	}));
	const manifest = signManifest(
		buildManifest(parts, archiveBytes, generatedAt),
		signingKey?.pem ?? null,
		signingKey?.id ?? null,
	);
	const envelope = `${JSON.stringify({ manifest, archive }, null, 2)}\n`;
	return { bytes: encoder.encode(envelope), manifest };
}

/** The deployment's export signing key, or null when it has none. */
function signingKeyFromEnv(): { pem: string; id: string } | null {
	const pem = process.env.PRIVACY_EXPORT_SIGNING_KEY?.trim();
	const id = process.env.PRIVACY_EXPORT_SIGNING_KEY_ID?.trim();
	return pem && id ? { pem, id } : null;
}

/** Builds the account's export and writes it to object storage under the case's key. */
export async function buildAndStoreExport(input: {
	caseId: string;
	userId: string;
	subjectEmailSha256: string;
	now: Date;
}): Promise<{ objectKey: string; manifest: PrivacyExportManifest }> {
	const files = await collectExportFiles(input.userId, input.subjectEmailSha256);
	const built = assembleExport(files, input.now, signingKeyFromEnv());
	const objectKey = exportObjectKey(input.caseId);
	await storage.put(PRIVACY_EXPORT_BUCKET, objectKey, built.bytes, "application/json");
	return { objectKey, manifest: built.manifest };
}

/**
 * Deletes every export whose link has expired, and clears its key and token on the case. The
 * manifest stays on the case: it is the record of what was sent, and holds no personal data.
 */
export async function sweepExpiredExports(now: Date, batch = 50): Promise<{ deleted: number }> {
	const db = getServiceDb();
	const expired = await db
		.select({ id: privacyCase.id, objectKey: privacyCase.exportObjectKey })
		.from(privacyCase)
		.where(and(isNotNull(privacyCase.exportObjectKey), lte(privacyCase.exportExpiresAt, now)))
		.limit(batch);
	let deleted = 0;
	for (const row of expired) {
		if (!row.objectKey) continue;
		await storage.del(PRIVACY_EXPORT_BUCKET, row.objectKey);
		await db
			.update(privacyCase)
			.set({ exportObjectKey: null, linkTokenSha256: null, updatedAt: now })
			.where(eq(privacyCase.id, row.id));
		deleted += 1;
	}
	return { deleted };
}

/**
 * Opens an export case for the account the CALLER has established is the signed-in subject, builds
 * the archive, stores it, and emails the subject a link that works for 72 hours.
 *
 * The case is fulfilled in the same call — an export is answered at once rather than within the
 * statutory month — and the ledger records each step, so the person's own request history shows it.
 * The archive is written BEFORE the case row commits its key: a failed write leaves an open case and
 * no link, never a link to nothing.
 */
export async function createDataExport(
	subject: { userId: string; email: string },
	now: Date,
): Promise<{ reference: string; expiresAt: Date }> {
	const db = getServiceDb();
	const reference = newReference();
	const emailHash = subjectHash(subject.email);
	const [row] = await db
		.insert(privacyCase)
		.values({
			reference,
			kind: "export",
			state: "in_review",
			subjectUserId: subject.userId,
			subjectEmailSha256: emailHash,
			organizationId: null,
			receivedAt: now,
			dueAt: new Date(now.getTime() + PRIVACY_RESPONSE_DAYS * 86_400_000),
			identityVerifiedAt: now,
		})
		.returning({ id: privacyCase.id });
	if (!row) throw new Error("Could not open the request.");
	await recordEvent(
		row.id,
		"received",
		{ summary: "Request received (export), from the subject's own account settings." },
		subject.userId,
	);
	await recordEvent(
		row.id,
		"identity_verified",
		{ summary: "Identity verified by the subject's own authenticated console session." },
		subject.userId,
	);

	const { expiresAt } = await deliverExport(
		{ id: row.id, reference, subjectEmailSha256: emailHash },
		subject,
		subject.userId,
		now,
	);
	return { reference, expiresAt };
}

/**
 * Builds and stores the export a case orders, fulfils the case, and emails the subject the link.
 * Shared by the self-serve button and the staff queue; the caller has established standing and that
 * identity was verified.
 */
export async function deliverExport(
	c: { id: string; reference: string; subjectEmailSha256: string },
	subject: { userId: string; email: string },
	actorUserId: string | null,
	now: Date,
): Promise<{ expiresAt: Date }> {
	const db = getServiceDb();
	const built = await buildAndStoreExport({
		caseId: c.id,
		userId: subject.userId,
		subjectEmailSha256: c.subjectEmailSha256,
		now,
	});
	const link = mintLinkToken();
	const expiresAt = new Date(now.getTime() + EXPORT_LINK_HOURS * 3_600_000);
	await db
		.update(privacyCase)
		.set({
			state: "fulfilled",
			decidedAt: now,
			decidedByUserId: actorUserId,
			exportObjectKey: built.objectKey,
			exportManifest: built.manifest,
			exportExpiresAt: expiresAt,
			linkTokenSha256: link.sha256,
			updatedAt: now,
		})
		.where(eq(privacyCase.id, c.id));
	await recordEvent(
		c.id,
		"export_generated",
		{
			summary:
				`Export generated (${built.manifest.signature ? "signed" : "unsigned"} manifest). The download ` +
				`link was emailed to the subject and expires at ${expiresAt.toISOString()}.`,
			counts: Object.fromEntries(built.manifest.parts.map((p) => [p.path, p.rows])),
		},
		actorUserId,
	);
	await sendDataExportReadyEmail({ to: subject.email, reference: c.reference, token: link.token, expiresAt });
	return { expiresAt };
}

/** What a download request gets. Only `ok` carries bytes. */
export type ExportDownload =
	| { outcome: "ok"; bytes: Uint8Array; reference: string }
	| { outcome: "not_found" }
	| { outcome: "expired" };

/**
 * Reads an export for `userId`, who must be the case's subject, holding the case's emailed token,
 * before its expiry. Every mismatch answers `not_found` alike, so a caller with the wrong account
 * or the wrong token learns nothing about which references exist. A download is recorded.
 */
export async function readExportForDownload(input: {
	reference: string;
	token: string;
	userId: string;
	now: Date;
}): Promise<ExportDownload> {
	const db = getServiceDb();
	const [c] = await db
		.select({
			id: privacyCase.id,
			reference: privacyCase.reference,
			subjectUserId: privacyCase.subjectUserId,
			linkTokenSha256: privacyCase.linkTokenSha256,
			exportObjectKey: privacyCase.exportObjectKey,
			exportExpiresAt: privacyCase.exportExpiresAt,
		})
		.from(privacyCase)
		.where(eq(privacyCase.reference, input.reference))
		.limit(1);
	if (!c || c.subjectUserId !== input.userId) return { outcome: "not_found" };
	if (!c.linkTokenSha256 || c.linkTokenSha256 !== hashLinkToken(input.token)) {
		return { outcome: "not_found" };
	}
	if (!c.exportObjectKey || !c.exportExpiresAt || c.exportExpiresAt <= input.now) {
		return { outcome: "expired" };
	}
	const bytes = await storage.get(PRIVACY_EXPORT_BUCKET, c.exportObjectKey);
	if (!bytes) return { outcome: "expired" };
	await recordEvent(c.id, "export_downloaded", { summary: "Export downloaded by the subject." }, input.userId);
	return { outcome: "ok", bytes, reference: c.reference };
}
