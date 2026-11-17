// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The hand-off contract between create-project and the canvas.
//
// Create-project makes a project in DRAFT with nothing deployed and opens the canvas with a SEED:
// what the canvas should start the design from. The canvas turns the seed into pending changes,
// once, and then removes the param. This module is the seed's type, its schema and its URL form.
// It does not know how a seed becomes nodes, and it imports nothing from the canvas or its stores.
//
// What a seed does NOT carry, and why:
//   - environments: a new project starts with production only, and the server creates it;
//   - the cloud account: it is bound on the create screen and is optional, so the project row holds
//     it (or holds none, which the canvas reports as a review issue);
//   - free text: every value is a member of a fixed list or a short identifier, and each object
//     refuses a key it does not name. A seed travels in a URL, so it holds identifiers only.
//
// The URL form is `?seed=v<version>.<kind>[.<value>…]`:
//   v1.blank
//   v1.template.<templateId>.<provider>
//   v1.byo.<chart|iac>
//   v1.proposal.<proposalId>
// To keep a seed anywhere else (a store, tab storage), keep this text: it carries the version.
//
// A template seed names an OFFERED cloud that a cluster can be provisioned on. `offered` defaults to
// the build-time list; see lib/projects/connected-account.ts for who passes the run-time list.
//
// No React, no `"use client"`, no server-only import: the canvas's server component and its client
// hook must read a link identically.

import { AVAILABLE_CLOUDS } from "@repo/cloud-catalog";
import { z } from "zod";
import type { TemplateId } from "@/components/create-project/templates";
import type { CloudProviderSlug } from "@/lib/cloud-providers";
import { isCloudProviderSlug } from "@/lib/cloud-providers/provider-slug";
import { type HandoffRefusal, isOfferedCloud } from "@/lib/projects/connected-account";
import type { ParamReader } from "@/lib/query/filter-url-codec";
import { projectHref } from "@/lib/routing";

/** The version of the URL form. A reader refuses every other version. */
export const CANVAS_SEED_VERSION = 1;

/** The param a seed travels in. */
export const CANVAS_SEED_PARAM = "seed";

/** The longest proposal id a seed holds. */
const MAX_PROPOSAL_ID_LENGTH = 64;

/** A proposal id: letters, digits, `-` and `_`, starting with a letter or a digit. A UUID fits. */
const PROPOSAL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Every template id. `satisfies` fails the build when the template list and this one differ. */
const TEMPLATE_IDS = { standard: true, ai: true, custom: true } satisfies Record<TemplateId, true>;

/** Narrows a string to a template id. */
function isTemplateId(value: string): value is TemplateId {
	return Object.hasOwn(TEMPLATE_IDS, value);
}

/** What a `byo` seed attaches, and the overlay wizard that attaches it. */
const BYO_WIZARD_IDS = { chart: "byo-chart", iac: "byo-iac" } as const;

/** What a `byo` seed attaches. */
export type ByoAttach = keyof typeof BYO_WIZARD_IDS;

/**
 * The seed's shape: one strict object per kind. Whether a template seed's cloud is OFFERED is not
 * in the schema, because the offered list is a run-time value; `parseCanvasSeed` and
 * `serialiseCanvasSeed` check it.
 */
export const canvasSeedSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("proposal"),
		proposalId: z.string().max(MAX_PROPOSAL_ID_LENGTH).regex(PROPOSAL_ID),
	}),
	z.strictObject({
		kind: z.literal("template"),
		templateId: z.custom<TemplateId>((value) => typeof value === "string" && isTemplateId(value)),
		provider: z.custom<CloudProviderSlug>(
			(value) => typeof value === "string" && isCloudProviderSlug(value),
		),
	}),
	z.strictObject({ kind: z.literal("blank") }),
	z.strictObject({ kind: z.literal("byo"), attach: z.enum(["chart", "iac"]) }),
]);

/** What the canvas starts a new project's design from. */
export type CanvasSeed =
	/** A design the server keeps: a repository scan's result, or the agent's. */
	| { readonly kind: "proposal"; readonly proposalId: string }
	/** A starter template on one cloud. */
	| {
			readonly kind: "template";
			readonly templateId: TemplateId;
			readonly provider: CloudProviderSlug;
	  }
	/** An empty board. */
	| { readonly kind: "blank" }
	/** An empty board with the attach flow for the user's own chart or IaC open. */
	| { readonly kind: "byo"; readonly attach: ByoAttach };

/** A seed, or why the value was refused. */
export type CanvasSeedResult =
	| { readonly ok: true; readonly seed: CanvasSeed }
	| { readonly ok: false; readonly reason: HandoffRefusal };

/** Thrown by `serialiseCanvasSeed` for a seed the contract refuses. */
export class CanvasSeedError extends Error {
	/** Why the seed was refused. */
	readonly reason: HandoffRefusal;

	/** Builds the error from the refusal. */
	constructor(reason: HandoffRefusal) {
		super(
			reason === "cloud-not-offered"
				? "The seed names a cloud that is not available in this release."
				: "The value is not a canvas seed.",
		);
		this.name = "CanvasSeedError";
		this.reason = reason;
	}
}

/** Checks a value against the schema, then a template seed's cloud against `offered`. */
function checkedSeed(value: unknown, offered: readonly string[]): CanvasSeedResult {
	const parsed = canvasSeedSchema.safeParse(value);
	if (!parsed.success) return { ok: false, reason: "malformed" };
	const seed = parsed.data;
	if (seed.kind === "template" && !isOfferedCloud(seed.provider, offered)) {
		return { ok: false, reason: "cloud-not-offered" };
	}
	return { ok: true, seed };
}

/** The seed's values after its kind, in the order the URL form writes them. */
function seedValues(seed: CanvasSeed): readonly string[] {
	switch (seed.kind) {
		case "proposal":
			return [seed.proposalId];
		case "template":
			return [seed.templateId, seed.provider];
		case "blank":
			return [];
		case "byo":
			return [seed.attach];
	}
}

/** The object the URL form's kind and values describe, or `null` when the count is wrong. */
function seedCandidate(kind: string, values: readonly string[]): unknown {
	const [first, second, ...rest] = values;
	if (rest.length > 0) return null;
	if (kind === "blank") return first === undefined ? { kind } : null;
	if (first === undefined) return null;
	if (kind === "template") {
		return second === undefined ? null : { kind, templateId: first, provider: second };
	}
	if (second !== undefined) return null;
	if (kind === "proposal") return { kind, proposalId: first };
	if (kind === "byo") return { kind, attach: first };
	return null;
}

/**
 * A seed in its URL form. Throws `CanvasSeedError` when the seed is not one the contract accepts:
 * a key the schema does not name, a value that is not an identifier, or a template on a cloud that
 * is not in `offered`.
 */
export function serialiseCanvasSeed(
	seed: CanvasSeed,
	offered: readonly string[] = AVAILABLE_CLOUDS,
): string {
	const checked = checkedSeed(seed, offered);
	if (!checked.ok) throw new CanvasSeedError(checked.reason);
	return [`v${CANVAS_SEED_VERSION}`, checked.seed.kind, ...seedValues(checked.seed)].join(".");
}

/**
 * Reads a seed's URL form. Refuses another version with `version`, a template on a cloud that is
 * not in `offered` — or on something that is not a cloud — with `cloud-not-offered`, and
 * everything else with `malformed`.
 */
export function parseCanvasSeed(
	raw: string,
	offered: readonly string[] = AVAILABLE_CLOUDS,
): CanvasSeedResult {
	const [versionPart, kind, ...values] = raw.split(".");
	const version = /^v(\d{1,6})$/.exec(versionPart ?? "")?.[1];
	if (version === undefined || kind === undefined) return { ok: false, reason: "malformed" };
	if (Number(version) !== CANVAS_SEED_VERSION) return { ok: false, reason: "version" };
	const candidate = seedCandidate(kind, values);
	if (candidate === null) return { ok: false, reason: "malformed" };
	const provider = kind === "template" ? values[1] : undefined;
	if (provider !== undefined && !isCloudProviderSlug(provider)) {
		return { ok: false, reason: "cloud-not-offered" };
	}
	return checkedSeed(candidate, offered);
}

/** The seed the URL carries, or `null` when it carries none or one the contract refuses. */
export function readCanvasSeed(
	params: ParamReader,
	offered: readonly string[] = AVAILABLE_CLOUDS,
): CanvasSeed | null {
	const raw = params.get(CANVAS_SEED_PARAM);
	if (raw === null) return null;
	const parsed = parseCanvasSeed(raw, offered);
	return parsed.ok ? parsed.seed : null;
}

/**
 * The link that opens a project's canvas with `seed`. Throws `CanvasSeedError` for a seed the
 * contract refuses, as `serialiseCanvasSeed` does.
 */
export function canvasHandoffHref(
	orgSlug: string,
	projectSlug: string,
	seed: CanvasSeed,
	offered: readonly string[] = AVAILABLE_CLOUDS,
): string {
	const query = new URLSearchParams({ [CANVAS_SEED_PARAM]: serialiseCanvasSeed(seed, offered) });
	return `${projectHref(orgSlug, projectSlug)}?${query.toString()}`;
}

/** The id of the overlay wizard a `byo` seed opens (`?wizard=<id>`). */
export function byoWizardId(attach: ByoAttach): string {
	return BYO_WIZARD_IDS[attach];
}
