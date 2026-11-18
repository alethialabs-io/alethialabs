// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The hand-off contract of cloud connect: what the flow gives back to the screen that opened it.
//
// A `ConnectedAccount` is two identifiers: the id of the stored cloud identity, and its cloud. It
// holds nothing else. Role ARNs, project numbers and every credential stay on the server, behind
// the identity id.
//
// A `ConnectedAccount` names an OFFERED cloud. The type is branded, so the only way to get one is
// `connectedAccount` or `parseConnectedAccount`, and both refuse a cloud that is not in `offered`.
//
// `offered` defaults to the build-time list (`AVAILABLE_CLOUDS`). An operator can re-enable a
// hidden cloud at run time, and only the server can read that setting
// (`offeredClouds()` in lib/cloud-providers/availability.ts). A server caller passes that list; a
// client caller passes the list the server handed it.
//
// The module has no React, no `"use client"` and no server-only import, so a server component and
// a client hook read the same value the same way.

import { AVAILABLE_CLOUDS, type CloudSlug, isCloudSlug } from "@repo/cloud-catalog";
import { z } from "zod";

/** The version of the serialised form. A reader refuses every other version. */
export const CONNECTED_ACCOUNT_VERSION = 1;

/** Why a hand-off value was refused. */
export type HandoffRefusal =
	/** The value does not have the contract's shape. */
	| "malformed"
	/** The value was written by another version of the contract. */
	| "version"
	/** The value names a cloud this deployment does not offer, or something that is not a cloud. */
	| "cloud-not-offered";

/** True when `slug` is one of the `offered` clouds. The match is exact. */
export function isOfferedCloud(slug: string, offered: readonly string[]): boolean {
	return offered.includes(slug);
}

/** A cloud slug the catalog lists. */
const cloudSlugSchema = z.custom<CloudSlug>(
	(value) => typeof value === "string" && isCloudSlug(value),
);

/**
 * The shape of a connected account: exactly two keys. An object with any other key is refused, so
 * a field cannot be added to the hand-off without changing this schema.
 */
export const connectedAccountSchema = z
	.strictObject({
		/** The id of the stored cloud identity. */
		identityId: z.guid(),
		/** The cloud the identity belongs to. */
		provider: cloudSlugSchema,
	})
	.brand<"ConnectedAccount">();

/** The account cloud connect gives back: a stored identity's id and its cloud, which is offered. */
export type ConnectedAccount = Readonly<z.infer<typeof connectedAccountSchema>>;

/** A connected account, or why the value was refused. */
export type ConnectedAccountResult =
	| { readonly ok: true; readonly account: ConnectedAccount }
	| { readonly ok: false; readonly reason: HandoffRefusal };

/** The serialised form: the two identifiers and the version that wrote them. */
const wireSchema = z.strictObject({
	version: z.literal(CONNECTED_ACCOUNT_VERSION),
	identityId: z.guid(),
	provider: cloudSlugSchema,
});

/** Enough of the serialised form to read its version before the rest is trusted. */
const versionedSchema = z.looseObject({ version: z.number(), provider: z.unknown().optional() });

/**
 * Builds a connected account from an identity id and a cloud slug. Refuses a cloud that is not in
 * `offered` with `cloud-not-offered`, and an id that is not a UUID with `malformed`.
 */
export function connectedAccount(
	input: { readonly identityId: string; readonly provider: string },
	offered: readonly string[] = AVAILABLE_CLOUDS,
): ConnectedAccountResult {
	if (!isOfferedCloud(input.provider, offered)) return { ok: false, reason: "cloud-not-offered" };
	const parsed = connectedAccountSchema.safeParse({
		identityId: input.identityId,
		provider: input.provider,
	});
	return parsed.success
		? { ok: true, account: parsed.data }
		: { ok: false, reason: "malformed" };
}

/** A connected account as text. `parseConnectedAccount` reads it back. */
export function serialiseConnectedAccount(account: ConnectedAccount): string {
	return JSON.stringify({
		version: CONNECTED_ACCOUNT_VERSION,
		identityId: account.identityId,
		provider: account.provider,
	});
}

/**
 * Reads text written by `serialiseConnectedAccount`. Refuses text of another version with
 * `version`, a cloud that is not in `offered` with `cloud-not-offered`, and everything else that
 * is not the serialised form — an extra key included — with `malformed`.
 */
export function parseConnectedAccount(
	raw: string,
	offered: readonly string[] = AVAILABLE_CLOUDS,
): ConnectedAccountResult {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return { ok: false, reason: "malformed" };
	}
	const versioned = versionedSchema.safeParse(value);
	if (!versioned.success) return { ok: false, reason: "malformed" };
	if (versioned.data.version !== CONNECTED_ACCOUNT_VERSION) return { ok: false, reason: "version" };
	const wire = wireSchema.safeParse(value);
	if (!wire.success) {
		const provider = versioned.data.provider;
		return typeof provider === "string" && !isCloudSlug(provider)
			? { ok: false, reason: "cloud-not-offered" }
			: { ok: false, reason: "malformed" };
	}
	return connectedAccount(wire.data, offered);
}
