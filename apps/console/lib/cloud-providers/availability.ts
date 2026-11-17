// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Which clouds this deployment offers — the server's one answer.
//
// The build-time answer is `availability` in packages/core/catalog/catalog.json, generated into
// `CLOUD_AVAILABILITY`. This module adds the one run-time input: the operator setting
// `ALETHIA_ENABLE_HIDDEN_CLOUDS`, a comma-separated list of cloud slugs that re-enables hidden
// clouds. The setting can only add clouds. A cloud enabled this way is not covered by the release's
// support or proofs.
//
// This is the only TypeScript module that reads the setting (Go's reader is packages/core/catalog).
// It is server-only: a client component must be handed the offered set by the server, never read
// the environment itself, so one deployment cannot show a cloud the server would then refuse.
//
// The setting is read on every call, not captured at import. Nothing here runs at startup, so a
// setting that names an unknown slug fails the first call that asks, with `HiddenCloudsConfigError`.

import "server-only";
import {
	CLOUD_AVAILABILITY,
	CONNECTABLE_CLOUDS,
	type ConnectableCloudSlug,
	PROVIDERS,
} from "./generated/catalog";
import { isConnectableCloudSlug } from "./provider-slug";

/** The operator setting that re-enables hidden clouds: comma-separated cloud slugs. */
export const HIDDEN_CLOUDS_ENV = "ALETHIA_ENABLE_HIDDEN_CLOUDS";

/** Thrown when the operator setting names something that is not a cloud slug. */
export class HiddenCloudsConfigError extends Error {
	/** The items of the setting that are not cloud slugs. */
	readonly unknown: readonly string[];

	/** Builds the error from the items that are not cloud slugs. */
	constructor(unknown: readonly string[]) {
		super(
			`${HIDDEN_CLOUDS_ENV} names ${unknown.join(", ")}, which is not a cloud. Use: ${CONNECTABLE_CLOUDS.join(", ")}.`,
		);
		this.name = "HiddenCloudsConfigError";
		this.unknown = unknown;
	}
}

/** The one refusal for a cloud this deployment does not offer. */
export class CloudNotOfferedError extends Error {
	/** The slug that was refused, as it was given. */
	readonly slug: string;

	/** Builds the refusal for one slug. */
	constructor(slug: string) {
		super(
			isConnectableCloudSlug(slug)
				? `${PROVIDERS[slug].name} is not available in this release.`
				: "This cloud is not available in this release.",
		);
		this.name = "CloudNotOfferedError";
		this.slug = slug;
	}
}

/**
 * The clouds the operator setting names, in the order written, without repeats. Blank items are
 * skipped. Throws `HiddenCloudsConfigError` when an item is not a cloud slug.
 */
export function enabledHiddenClouds(): readonly ConnectableCloudSlug[] {
	const enabled: ConnectableCloudSlug[] = [];
	const unknown: string[] = [];
	for (const item of (process.env[HIDDEN_CLOUDS_ENV] ?? "").split(",")) {
		const slug = item.trim();
		if (slug === "") continue;
		if (!isConnectableCloudSlug(slug)) {
			if (!unknown.includes(slug)) unknown.push(slug);
		} else if (!enabled.includes(slug)) {
			enabled.push(slug);
		}
	}
	if (unknown.length > 0) throw new HiddenCloudsConfigError(unknown);
	return enabled;
}

/**
 * The clouds this deployment offers, in catalog order: every available cloud, plus each hidden
 * cloud the operator setting names. Throws `HiddenCloudsConfigError` on a bad setting.
 */
export function offeredClouds(): readonly ConnectableCloudSlug[] {
	const enabled = enabledHiddenClouds();
	return CONNECTABLE_CLOUDS.filter(
		(slug) => CLOUD_AVAILABILITY[slug] === "available" || enabled.includes(slug),
	);
}

/** True when the slug is a cloud this deployment offers. False for anything that is not a cloud. */
export function isCloudOffered(slug: string): boolean {
	return isConnectableCloudSlug(slug) && offeredClouds().includes(slug);
}

/** Throws `CloudNotOfferedError` unless the slug is a cloud this deployment offers. */
export function assertCloudOffered(slug: string): void {
	if (!isCloudOffered(slug)) throw new CloudNotOfferedError(slug);
}

/**
 * Test helper: runs `fn` with the operator setting naming exactly `slugs`, then puts the previous
 * value back, also when `fn` throws. Every test that needs a hidden cloud to be offered goes through
 * this, so the opt-ins can be found with one search. It changes `process.env`, which a process
 * shares: do not run two of these concurrently.
 */
export async function withHiddenClouds<T>(
	slugs: readonly ConnectableCloudSlug[],
	fn: () => T | Promise<T>,
): Promise<T> {
	const previous = process.env[HIDDEN_CLOUDS_ENV];
	process.env[HIDDEN_CLOUDS_ENV] = slugs.join(",");
	try {
		return await fn();
	} finally {
		if (previous === undefined) delete process.env[HIDDEN_CLOUDS_ENV];
		else process.env[HIDDEN_CLOUDS_ENV] = previous;
	}
}
