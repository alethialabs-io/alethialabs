// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The warm-pool wizard, declared once for the wizard engine (`lib/wizard/`).
//
// Five steps — cloud, placement, capacity, version, review — each owning the fields it renders. The
// two advanced knobs, `surge` and `scaleDownGraceTicks`, belong to Capacity, where they render inside
// the "Advanced scaling" block: a value that fails there (on Next, on Create, or in a server refusal)
// sends the person back to Capacity with that block open and the field focused, instead of a Create
// button that does nothing visible (C-25). `tests/lib/wizard/definitions.test.ts` holds this file to
// that: every key of the submit schema below has exactly one owner.
//
// Number fields hold `null` while they are empty, so an emptied field is kept in the draft as empty
// and fails with "Required" rather than as an unreadable NaN.
//
// The draft keeps every field: a pool has no credential or payment detail in it.

import { z } from "zod";
import { DEFAULT_REGION } from "@/lib/cloud-providers/generated/catalog";
import { isCloudProviderSlug } from "@/lib/cloud-providers/provider-slug";
import { cloudProvider } from "@/lib/db/schema/enums";
import type { FleetPoolCreateInput } from "@/lib/validations/fleet";
import { defineWizard } from "@/lib/wizard/define";

/** The wizard's URL and draft namespace (`?wizard=fleet-pool`). */
export const FLEET_POOL_WIZARD_ID = "fleet-pool";

/** A whole-number field with a floor, saying "Required" when it is empty. */
function count(min: number) {
	return z
		.number({ error: "Required" })
		.int("Use a whole number.")
		.min(min, min === 0 ? "Can't be negative" : `At least ${min}`);
}

/** Every field of the form, without the rules that compare two of them. */
const fieldsSchema = z.object({
	provider: z.enum(cloudProvider.enumValues, { error: "Choose a cloud." }),
	name: z.string().trim().max(60, "Keep the name to 60 characters."),
	locationsCsv: z.string(),
	minPerLocation: count(0),
	warmMin: count(0),
	max: count(1),
	buffer: count(0),
	slotsPerRunner: count(1),
	surge: count(1),
	scaleDownGraceTicks: count(1),
	versionSource: z.enum(["channel", "pin"]),
	channel: z.string(),
	version: z.string(),
});

/** The form's values as typed. */
export type FleetPoolWizardValues = z.input<typeof fieldsSchema>;

/** The location codes in a comma-separated entry, trimmed, blanks dropped. */
export function parseLocations(csv: string | undefined): string[] {
	return (csv ?? "")
		.split(",")
		.map((code) => code.trim())
		.filter(Boolean);
}

/** The location entry a new pool on `provider` starts with: that cloud's default region. */
export function defaultLocationsFor(provider: string | undefined): string {
	return provider !== undefined && isCloudProviderSlug(provider) ? DEFAULT_REGION[provider] : "";
}

/** Placement: at least one location. */
function placementRule<T extends { locationsCsv: string }>(v: T, ctx: z.RefinementCtx<T>): void {
	if (parseLocations(v.locationsCsv).length === 0) {
		ctx.addIssue({ code: "custom", path: ["locationsCsv"], message: "Add at least one location code." });
	}
}

/**
 * Capacity: the ceiling is at least the floor, and the idle buffer fits under the ceiling. A pair
 * with an empty side is not compared: that field already says "Required".
 */
function capacityRule<T extends { warmMin: number; max: number; buffer: number }>(
	v: T,
	ctx: z.RefinementCtx<T>,
): void {
	const known = (n: number) => Number.isFinite(n);
	if (known(v.max) && known(v.warmMin) && v.max < v.warmMin) {
		ctx.addIssue({ code: "custom", path: ["max"], message: "Max must be at least the warm minimum." });
	}
	if (known(v.max) && known(v.buffer) && v.buffer > v.max) {
		ctx.addIssue({ code: "custom", path: ["buffer"], message: "Buffer can't exceed max." });
	}
}

/** Version: the chosen source has a value. */
function versionRule<T extends { versionSource: "channel" | "pin"; channel: string; version: string }>(
	v: T,
	ctx: z.RefinementCtx<T>,
): void {
	if (v.versionSource === "pin" && !v.version.trim()) {
		ctx.addIssue({ code: "custom", path: ["version"], message: "Enter a version to pin." });
	}
	if (v.versionSource === "channel" && !v.channel.trim()) {
		ctx.addIssue({ code: "custom", path: ["channel"], message: "Enter a channel name." });
	}
}

/** Parsed form values as the server's create input. */
function toInput(v: z.output<typeof fieldsSchema>): FleetPoolCreateInput {
	const name = v.name.trim();
	return {
		provider: v.provider,
		name: name === "" ? undefined : name,
		locations: parseLocations(v.locationsCsv),
		warmMin: v.warmMin,
		max: v.max,
		slotsPerRunner: v.slotsPerRunner,
		minPerLocation: v.minPerLocation,
		surge: v.surge,
		buffer: v.buffer,
		scaleDownGraceTicks: v.scaleDownGraceTicks,
		version: v.versionSource === "pin" ? v.version.trim() || undefined : undefined,
		channel: v.versionSource === "channel" ? v.channel.trim() || undefined : undefined,
	};
}

/** The wizard's submit contract: every field, every cross-field rule, mapped to the server input. */
const fleetPoolWizardSchema = fieldsSchema
	.superRefine((v, ctx) => {
		placementRule(v, ctx);
		capacityRule(v, ctx);
		versionRule(v, ctx);
	})
	.transform(toInput);

/** A number the draft may keep: a value, or `null` for an emptied field. */
const draftCount = z.number().nullable().optional();

/** The warm-pool wizard: an overlay on the runners page, its draft kept per org and per pool. */
export const fleetPoolWizard = defineWizard<FleetPoolWizardValues, FleetPoolCreateInput>({
	id: FLEET_POOL_WIZARD_ID,
	presentation: "overlay",
	schema: fleetPoolWizardSchema,
	steps: [
		{
			id: "cloud",
			label: "Cloud",
			fields: ["provider", "name"],
			schema: fieldsSchema.pick({ provider: true, name: true }),
		},
		{
			id: "placement",
			label: "Placement",
			fields: ["locationsCsv", "minPerLocation"],
			schema: fieldsSchema.pick({ locationsCsv: true, minPerLocation: true }).superRefine(placementRule),
		},
		{
			id: "capacity",
			label: "Capacity",
			fields: ["warmMin", "max", "buffer", "slotsPerRunner", "surge", "scaleDownGraceTicks"],
			schema: fieldsSchema
				.pick({
					warmMin: true,
					max: true,
					buffer: true,
					slotsPerRunner: true,
					surge: true,
					scaleDownGraceTicks: true,
				})
				.superRefine(capacityRule),
		},
		{
			id: "version",
			label: "Version",
			fields: ["versionSource", "channel", "version"],
			schema: fieldsSchema.pick({ versionSource: true, channel: true, version: true }).superRefine(versionRule),
		},
		{
			id: "review",
			label: "Review",
			fields: [],
			schema: z.object({}),
		},
	],
	draft: {
		version: 1,
		ttlMinutes: 24 * 60,
		schema: z.object({
			provider: z.enum(cloudProvider.enumValues).optional(),
			name: z.string().optional(),
			locationsCsv: z.string().optional(),
			minPerLocation: draftCount,
			warmMin: draftCount,
			max: draftCount,
			buffer: draftCount,
			slotsPerRunner: draftCount,
			surge: draftCount,
			scaleDownGraceTicks: draftCount,
			versionSource: z.enum(["channel", "pin"]).optional(),
			channel: z.string().optional(),
			version: z.string().optional(),
		}),
	},
});
