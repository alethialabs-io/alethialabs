// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { addonMode, environmentLifecycle, environmentStage, placementMode } from "@/lib/db/schema/enums";
import { isNotReservedTfvarKey, RESERVED_TFVAR_MESSAGE } from "@/lib/validations/byo-iac";
import { cliProjectNodeShapeRequest } from "@/lib/validations/cli-contract";
import { environmentNameSchema, namespaceSchema } from "@/lib/validations/names";
import { environmentMatrixSchema } from "@/lib/validations/project-form.schema";

/**
 * The request-body validators of the public API routes whose validator is a module-local `const`
 * in the route file.
 *
 * A Next.js route module may export only its HTTP handlers and route config, so these cannot be
 * imported from the route. Each one here is the route's own validator, COPIED, and it is held to the
 * route by `tests/lib/openapi/drift.test.ts`: the test parses both files and requires the two
 * initializers — and every route-local constant they name — to print identically once comments
 * and whitespace are dropped. Editing the route's validator without editing the copy fails that
 * test, so the copy cannot describe a body the route no longer accepts.
 *
 * Each entry is keyed by the route file (relative to `apps/console`) and the `const`'s name there.
 * Where a route validates with an exported schema (`projectFormSchema`, the design document) the
 * document imports that schema directly and nothing is copied.
 */

/** Copy of `DEFAULT_IAC_VERSION` in app/api/cli/projects/route.ts. */
const DEFAULT_IAC_VERSION = "1.11.4";

/** Copy of `createProjectBody` in app/api/cli/projects/route.ts. */
const createProjectBody = z
	.object({
		project_name: z.string().min(1).max(120),
		region: z.string().min(1),
		cloud_identity_id: z.string().uuid().optional(),
		stage: z.enum(environmentStage.enumValues).default("development"),
		iac_version: z.string().min(1).default(DEFAULT_IAC_VERSION),
		placement_mode: z.enum(placementMode.enumValues).optional(),
		environments: environmentMatrixSchema.optional(),
		...cliProjectNodeShapeRequest.shape,
	})
	.superRefine((body, ctx) => {
		if (body.instance_type !== undefined && body.node_size !== undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["node_size"],
				message: "instance_type and node_size are mutually exclusive: pass one",
			});
		}
		if (body.instance_type !== undefined && body.cloud_identity_id === undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["instance_type"],
				message:
					"instance_type names one cloud's machine type, so it needs cloud_identity_id; use node_size for a cloud-indifferent size",
			});
		}
	});

/** Copy of `addEnvironmentBody` in app/api/cli/projects/[id]/environments/route.ts. */
const addEnvironmentBody = z.object({
	name: environmentNameSchema,
	stage: z.enum(environmentStage.enumValues).default("development"),
	region: z.string().min(1).optional(),
	placement_mode: z.enum(placementMode.enumValues).default("namespace"),
	fabric: z.string().min(1).optional(),
	namespace: namespaceSchema.optional(),
	lifecycle: z.enum(environmentLifecycle.enumValues).optional(),
});

/** Copy of `enableAddonBody` in app/api/cli/projects/[id]/addons/route.ts. */
const enableAddonBody = z.object({
	addon_id: z.string().min(1),
	mode: z.enum(addonMode.enumValues).optional(),
	values: z.record(z.string(), z.unknown()).optional(),
	values_yaml: z.string().nullish(),
	version: z.string().nullish(),
});

/** Copy of `disableAddonBody` in app/api/cli/projects/[id]/addons/route.ts. */
const disableAddonBody = z.object({ addon_id: z.string().min(1) });

/** Copy of `bumpBody` in app/api/cli/projects/[id]/addons/bump/route.ts. */
const bumpBody = z.object({
	addon_id: z.string().min(1).max(128),
	again: z.boolean().optional(),
});

/** Copy of `attachChartBody` in app/api/cli/projects/[id]/byo-charts/route.ts. */
const attachChartBody = z.object({
	id: z.string().trim().min(1),
	repo_url: z.string().trim().min(1),
	chart_path: z.string().trim().optional(),
	ref: z.string().trim().optional(),
	namespace: z.string().trim().optional(),
	values_yaml: z.string().nullish(),
	git_credential_id: z.string().min(1).nullish(),
	values: z.record(z.string(), z.unknown()).optional(),
});

/** Copy of `detachChartBody` in app/api/cli/projects/[id]/byo-charts/route.ts. */
const detachChartBody = z.object({ id: z.string().trim().min(1) });

/** Copy of `scanChartBody` in app/api/cli/projects/[id]/byo-charts/scan/route.ts. */
const scanChartBody = z.object({ id: z.string().trim().min(1) });

/** Copy of `attachIacBody` in app/api/cli/projects/[id]/byo-iac/route.ts. */
const attachIacBody = z.object({
	repo_url: z.string().trim().min(1),
	ref: z.string().trim().min(1).nullish(),
	path: z.string().trim().optional(),
	git_credential_id: z.string().uuid().nullish(),
	var_values: z
		.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
		.refine(
			(v) => Object.keys(v).every(isNotReservedTfvarKey),
			RESERVED_TFVAR_MESSAGE,
		)
		.optional(),
});

/** Copy of `addComponentBody` in app/api/cli/projects/[id]/components/[kind]/route.ts. */
const addComponentBody = z.object({
	name: z.string().min(1).optional(),
	fields: z.record(z.string(), z.unknown()).default({}),
});

/** Copy of `updateComponentBody` in app/api/cli/projects/[id]/components/[kind]/[name]/route.ts. */
const updateComponentBody = z
	.object({ fields: z.record(z.string(), z.unknown()) })
	.strict();

/** One copied validator: the route file it came from, the `const` it copies, and the schema. */
export interface RouteBody {
	/** The route file, relative to `apps/console`. */
	readonly route: string;
	/** The name of the `const` in that file. */
	readonly name: string;
	/** The copied schema. */
	readonly schema: z.ZodType;
}

/** Every copied validator, keyed for the operation table to reference. */
export const ROUTE_BODIES = {
	createProject: {
		route: "app/api/cli/projects/route.ts",
		name: "createProjectBody",
		schema: createProjectBody,
	},
	addEnvironment: {
		route: "app/api/cli/projects/[id]/environments/route.ts",
		name: "addEnvironmentBody",
		schema: addEnvironmentBody,
	},
	enableAddon: {
		route: "app/api/cli/projects/[id]/addons/route.ts",
		name: "enableAddonBody",
		schema: enableAddonBody,
	},
	disableAddon: {
		route: "app/api/cli/projects/[id]/addons/route.ts",
		name: "disableAddonBody",
		schema: disableAddonBody,
	},
	bumpAddon: {
		route: "app/api/cli/projects/[id]/addons/bump/route.ts",
		name: "bumpBody",
		schema: bumpBody,
	},
	attachChart: {
		route: "app/api/cli/projects/[id]/byo-charts/route.ts",
		name: "attachChartBody",
		schema: attachChartBody,
	},
	detachChart: {
		route: "app/api/cli/projects/[id]/byo-charts/route.ts",
		name: "detachChartBody",
		schema: detachChartBody,
	},
	scanChart: {
		route: "app/api/cli/projects/[id]/byo-charts/scan/route.ts",
		name: "scanChartBody",
		schema: scanChartBody,
	},
	attachIac: {
		route: "app/api/cli/projects/[id]/byo-iac/route.ts",
		name: "attachIacBody",
		schema: attachIacBody,
	},
	addComponent: {
		route: "app/api/cli/projects/[id]/components/[kind]/route.ts",
		name: "addComponentBody",
		schema: addComponentBody,
	},
	updateComponent: {
		route: "app/api/cli/projects/[id]/components/[kind]/[name]/route.ts",
		name: "updateComponentBody",
		schema: updateComponentBody,
	},
} as const satisfies Record<string, RouteBody>;

/** The source file of this module, relative to `apps/console`, for the drift test to parse. */
export const ROUTE_BODIES_SOURCE = "lib/openapi/route-bodies.ts";
