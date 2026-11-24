// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { AGENT_SCOPES, APPLY_OPERATIONS } from "@/lib/approvals/types";
import {
	addonMode,
	alertChannelType,
	alertSeverity,
	environmentLifecycle,
	environmentStage,
	placementMode,
} from "@/lib/db/schema/enums";
import { isNotReservedTfvarKey, RESERVED_TFVAR_MESSAGE } from "@/lib/validations/byo-iac";
import { resourceKindSchema } from "@/lib/validations/classification";
import { cliProjectNodeShapeRequest } from "@/lib/validations/cli-contract";
import { environmentNameSchema, namespaceSchema } from "@/lib/validations/names";
import { environmentMatrixSchema } from "@/lib/validations/project-form.schema";

/**
 * The request-body validators of the `/api/cli` routes.
 *
 * A Next.js route module may export only its HTTP handlers and route config, so a validator that
 * lives in a route file cannot be imported by anything else. These live here instead, and each
 * route imports its own — as does the public OpenAPI document (lib/openapi), which therefore
 * describes exactly the body the route accepts, from one definition.
 *
 * `tests/lib/openapi/drift.test.ts` holds that arrangement: a documented route that validates its
 * body with a schema it declares itself, rather than one it imports, fails it.
 */

// ── Projects ───────────────────────────────────────────────────────────────────────────────────

/** Default OpenTofu version when the caller doesn't pin one (matches the console form). */
const DEFAULT_IAC_VERSION = "1.11.4";

/** Body of POST /api/cli/projects — create a project (+ its default environment).
 *
 * `placement_mode` and `environments` were the two fields the CLI never sent, even though
 * `insertProjectWithDefaultFabric` has always accepted and validated them. The consequence was not a
 * missing feature but a cost one: with no matrix, EVERY environment the CLI created came out
 * `dedicated`, which is a cluster each. A four-cloud two-tier demo built from the terminal
 * provisioned eight clusters where the product's own placement story provisions four.
 *
 * `environments` reuses the console form's own validator (`environmentMatrixSchema`) rather than
 * restating it, so the shape the fan-out receives is the shape the fan-out was written against.
 *
 * `instance_type` / `node_size` (#5266) are the node shape, from the wire contract
 * (`cliProjectNodeShapeRequest`, which the Go client is strict-decoded against). They are mutually
 * exclusive: the Go resolver PREFERS `instance_types` over `node_size`, so a row carrying both would
 * provision the machine type and silently ignore the size the caller also asked for. A machine type
 * also needs a cloud, because it names one cloud's SKU — with no linked account there is nothing to
 * say it belongs to. */
export const createProjectBody = z
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

/** Body of POST /api/cli/projects/:id/environments — add an environment.
 *
 * `placement_mode` and its companions are the fix for a silent cost bomb. This route inserted with
 * `fabric_id` unset, and `project_environments.placement_mode` defaults to `dedicated` — so
 * `project env add staging` did not fail, it quietly became a WHOLE NEW CLUSTER with its own tofu
 * state key. The isolation ladder the product leads with (namespace → vcluster → dedicated) was
 * unreachable from the CLI, and the cheap rungs are the interesting ones. */
export const addEnvironmentBody = z.object({
	/** Validated AND normalized by the shared rule (lib/validations/names.ts), which is the same
	 *  one `project create --env` and the console's own `addEnvironment` action now use. Parsing
	 *  yields the stored slug, so this route cannot forget the normalization step — and it now
	 *  refuses a name a console route would permanently shadow (`project env add settings` used to
	 *  create an environment whose URL was unreachable forever). */
	name: environmentNameSchema,
	stage: z.enum(environmentStage.enumValues).default("development"),
	region: z.string().min(1).optional(),
	/** Defaults to `namespace`: an environment ADDED to an existing project is the cheap-rung case,
	 *  and the expensive one should be the word you typed rather than the one you got. */
	placement_mode: z.enum(placementMode.enumValues).default("namespace"),
	/** The Fabric to place onto, by name. Ignored for `dedicated` (which owns a new Fabric).
	 *  Defaults to the project's default Fabric — "the second tier is free" only works if a shared
	 *  placement lands on the Fabric that already exists. */
	fabric: z.string().min(1).optional(),
	/** ArgoCD destination namespace for a shared placement. NULL → derived from the env name.
	 *  Kubernetes' own grammar, exactly. The pattern here required a leading letter and constrained
	 *  nothing at the end, so it ACCEPTED `dev-` — which Kubernetes refuses, making the failure
	 *  arrive at apply time naming a namespace rather than a name — and refused `1dev`, which
	 *  Kubernetes accepts. */
	namespace: namespaceSchema.optional(),
	lifecycle: z.enum(environmentLifecycle.enumValues).optional(),
});

/** Body of POST .../addons — enable or reconfigure one catalog add-on.
 *
 * `values` is intentionally an open record at the EDGE and narrowed immediately after: `enableAddon`
 * runs the add-on's own `def.configSchema.safeParse` on it, so each add-on's knobs are validated by
 * the definition that owns them rather than by a second schema here that would drift from the
 * catalog. `values_yaml` is the Advanced raw-Helm escape hatch, parsed and rejected as YAML by the
 * same action.
 *
 * One rule for every optional field (#5545, and #5525 for `version`): ABSENT keeps what is stored.
 * `values_yaml` and `version` are cleared by `null` or `""`; a `values` key is merged over the stored
 * knobs, and a key sent as `null` is reset to the add-on's default; `mode` absent keeps the stored
 * mode. `reconfigure.ts` applies it. A `version` pin is checked by `lib/addons/chart-version.ts`
 * inside `enableAddon` — one definition of a valid pin, refused with the same sentence the console
 * shows. */
export const enableAddonBody = z.object({
	addon_id: z.string().min(1),
	mode: z.enum(addonMode.enumValues).optional(),
	values: z.record(z.string(), z.unknown()).optional(),
	values_yaml: z.string().nullish(),
	version: z.string().nullish(),
});

/** Body of DELETE .../addons — disable one add-on. */
export const disableAddonBody = z.object({ addon_id: z.string().min(1) });

/** Body of POST .../addons/bump. */
export const bumpBody = z.object({
	addon_id: z.string().min(1).max(128),
	again: z.boolean().optional(),
});

/**
 * Body of POST .../byo-charts — attach or update one BYO Helm chart.
 *
 * snake_case on the wire, matching every other CLI route and `byoChartWire`, then mapped to
 * `attachByoChart`'s camelCase input. The mapping is naming only: `byoChartAttachSchema.parse` inside
 * the action is what decides validity — the repo-URL shape, the git-chart-needs-a-path refinement,
 * and the YAML-mapping check — so there is still exactly one definition of a valid chart.
 */
export const attachChartBody = z.object({
	id: z.string().trim().min(1),
	repo_url: z.string().trim().min(1),
	chart_path: z.string().trim().optional(),
	ref: z.string().trim().optional(),
	namespace: z.string().trim().optional(),
	values_yaml: z.string().nullish(),
	git_credential_id: z.string().min(1).nullish(),
	values: z.record(z.string(), z.unknown()).optional(),
});

/** Body of DELETE .../byo-charts — detach one chart by id. */
export const detachChartBody = z.object({ id: z.string().trim().min(1) });

/** Body of POST .../byo-charts/scan — scan one attached chart by id. */
export const scanChartBody = z.object({ id: z.string().trim().min(1) });

/**
 * Body of POST .../byo-iac — attach (or replace) the environment's BYO IaC source.
 *
 * snake_case matches `iacSourceAttachSchema`'s own field names, so this body IS that shape plus
 * nothing. `attachIacSource` re-parses it with that schema, which is what normalises the path
 * ("/foo/" → "foo") and enforces the scalar-only tfvars rule — a nested object or an array in
 * `var_values` is refused there rather than being written and failing at apply.
 */
export const attachIacBody = z.object({
	repo_url: z.string().trim().min(1),
	ref: z.string().trim().min(1).nullish(),
	path: z.string().trim().optional(),
	git_credential_id: z.string().uuid().nullish(),
	// The reserved platform namespace, checked HERE and not only in the action. attachIacSource
	// validates with the throwing `.parse()`, and byoWriteError classifies an escaped ZodError by
	// regex over its message — which for this rule fell through to a 500 carrying a raw Zod dump.
	// A rule the CLI can trip needs a 400 that names the field, not a server fault.
	var_values: z
		.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
		.refine(
			(v) => Object.keys(v).every(isNotReservedTfvarKey),
			RESERVED_TFVAR_MESSAGE,
		)
		.optional(),
});

/** Body of POST .../components/:kind — `fields` is the open `--set` field map, validated
 * server-side against the kind's drizzle-zod insert schema. */
export const addComponentBody = z.object({
	name: z.string().min(1).optional(),
	fields: z.record(z.string(), z.unknown()).default({}),
});

/** Body of PATCH .../components/:kind/:name — the fields to change, and nothing else. `strict` so a
 * `name` (a rename) or any other key is a 400 rather than silently ignored. */
export const updateComponentBody = z
	.object({ fields: z.record(z.string(), z.unknown()) })
	.strict();

// ── Organization administration ────────────────────────────────────────────────────────────────

/** Body of POST /api/cli/orgs/:id/teams — create a team. */
export const createTeamBody = z.object({ name: z.string().min(1) });

/** Body of POST /api/cli/orgs/:id/members — invite a user by email. */
export const inviteBody = z.object({
	email: z.string().email(),
	role: z.string().min(1),
});

/** Body of POST /api/cli/roles — a named custom role plus its permission keys. */
export const createRoleBody = z.object({
	name: z.string().min(1).max(120),
	permission_keys: z.array(z.string()).default([]),
});

/** Body of POST /api/cli/grants — bind a principal to EXACTLY one of a role or a
 * single permission, at a resource scope, as allow or deny. resource_id omitted =
 * org-wide.
 *
 * `resource_type` stays `z.string()` HERE and is parsed by `parseGrantResource` in the handler,
 * not turned into a `z.enum`. A parse failure on this schema answers with a flat "Invalid request
 * body" that names no field, and #4734 turns on the refusal NAMING the accepted set — an admin who
 * wrote `projects` has to be able to see what the kinds are. The org-kind-with-an-id refusal is
 * returned from the same parse, for the same reason. */
export const createGrantBody = z.object({
	principal_type: z.enum(["user", "team"]),
	principal_id: z.uuid(),
	effect: z.enum(["allow", "deny"]).default("allow"),
	role_id: z.uuid().nullable().optional(),
	permission_key: z.string().nullable().optional(),
	resource_type: z.string().min(1).default("org"),
	resource_id: z.uuid().nullable().optional(),
});

/** Body of POST /api/approvals — request a person's approval to deploy or destroy a reviewed plan. */
export const requestApprovalBody = z.object({
	plan_job_id: z.uuid(),
	operation: z.enum(APPLY_OPERATIONS),
	/** The requester's note, untrusted text (lib/approvals/request.ts keeps at most 500 characters). */
	reason: z.string().max(500).nullish(),
});

/** Body of POST /api/cli/tokens — mint a service token. */
export const createTokenSchema = z.object({
	name: z.string().trim().min(1, "a token needs a name").max(120),
	/** Days until expiry. Omitted ⇒ non-expiring, which the caller chooses explicitly. */
	expires_in_days: z.number().int().positive().max(3650).optional(),
	/** The verbs the token may use. Omitted ⇒ every scope. An unknown scope is a 400. */
	scopes: z.array(z.enum(AGENT_SCOPES)).min(1).optional(),
	/** The projects the token may touch. Omitted ⇒ every project of the org. */
	project_ids: z.array(z.uuid()).min(1).optional(),
});

/** Body of POST /api/cli/classification/assignments — assign one classification value to a
 * resource, addressed by dimension key and value slug. */
export const assignBody = z.object({
	kind: resourceKindSchema,
	id: z.string().uuid(),
	dimension_key: z.string().min(1),
	value_slug: z.string().min(1),
});

// ── Alerts ─────────────────────────────────────────────────────────────────────────────────────

/** Body of POST /api/cli/alerts — bind a set of event-key patterns to channels. */
export const createAlertBody = z.object({
	name: z.string().min(1).max(120),
	event_patterns: z.array(z.string().min(1)).min(1),
	channel_ids: z.array(z.uuid()).min(1),
	severity: z.enum(alertSeverity.enumValues).default("warning"),
});

/** Body of POST /api/cli/channels — `config` carries email recipients and/or the
 * transport's destination (URL / signing secret / PagerDuty routing key). */
export const createChannelBody = z.object({
	name: z.string().min(1).max(120),
	type: z.enum(alertChannelType.enumValues),
	config: z
		.object({
			recipients: z.array(z.string().email()).optional(),
			url: z.string().url().optional(),
			signing_secret: z.string().min(1).optional(),
			routing_key: z.string().min(1).optional(),
		})
		.default({}),
});

// ── Runners and fleet ──────────────────────────────────────────────────────────────────────────

/**
 * Body of POST /api/cli/runners/register.
 *
 * `metadata` is deliberately NOT accepted. `runners.metadata` is
 * `jsonb().$type<RunnerMetadata>()` — a known shape whose fields (`deploy_config`,
 * `cloud_instance_id`) are server-managed: the fleet scaler correlates a DB runner to its VM
 * through `cloud_instance_id`, and `deploy_config` records what a DEPLOY_RUNNER job was given.
 * Accepting it would let a caller write arbitrary JSON into a typed field the fleet controller
 * reads, and no client has ever sent it.
 */
export const registerRunnerBody = z.object({
	name: z.string().min(1).max(120),
	cloud_identity_id: z.string().uuid().optional(),
});

/** Body of PUT /api/cli/fleet/:provider — the editable subset of a pool's config. A
 * pinned `version` and a release `channel` are mutually exclusive (a version pin wins). */
export const updateFleetBody = z.object({
	warm_min: z.number().int().min(0).optional(),
	max: z.number().int().min(0).optional(),
	slots_per_runner: z.number().int().min(1).optional(),
	enabled: z.boolean().optional(),
	channel: z.string().min(1).nullable().optional(),
	version: z.string().min(1).nullable().optional(),
});
