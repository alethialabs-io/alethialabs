// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The declared DESIGN tools (lib/ai/mcp/surface.ts): `validate_design`, `apply_design_patch` and
// `create_project`. None of them has a cloud effect. A design is the document the console's canvas
// saves and the CLI's design route applies — `designSaveSchema`, the board's own validator — and the
// two writes go through the same server actions those surfaces use (`updateProjectDesign`,
// `tryCreateProject`), which authorize the caller and refuse a credential or a cloud account the
// caller may not use. Everything a caller can fix comes back as data (`errors`), not as a tool error.
//
// A repeated write with the same idempotency key answers with the first result: the key is recorded,
// hashed with the caller's organisation and person, on the audit row the write produced
// (lib/ai/mcp/design-store.ts).

import "server-only";
import { z } from "zod";
import type { Actor } from "@/lib/authz/types";
import { designSaveSchema } from "@/lib/validations/project-form.schema";
import { applyJsonPatch, formatPointer } from "./json-patch";
import { type HandledTool, served } from "./served";
import { EXTERNAL_TOOLS, type ExternalToolName } from "./surface";

/** One problem with a design, as the design tools return it. */
export interface DesignProblem {
	path: string;
	code: string;
	message: string;
	fix: string | null;
}

/** A validated design, as the design writes take it. */
export type ValidDesign = z.output<typeof designSaveSchema>;

/** A write's outcome: done, or a refusal the caller can act on. */
type DesignWriteResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Everything the design tools reach outside themselves. */
export interface DesignDeps {
	/** The design of one environment; authorizes the caller to view the project, else throws. */
	readDesign(projectId: string, environmentId: string | undefined): Promise<unknown>;
	/** The project's design revision (lib/ai/mcp/design-store.ts). */
	designRevision(actor: Actor, projectId: string): Promise<number>;
	/** The revision of the design write of `projectId` that recorded `keyHash`, or null. */
	findKeyedWrite(actor: Actor, projectId: string, keyHash: string): Promise<number | null>;
	/** The id of the organisation's project named `name`, or null. */
	findProjectByName(actor: Actor, name: string): Promise<string | null>;
	/** `key` as the value a design write records. */
	keyHash(actor: Actor, key: string): string;
	/** Saves `design` to one environment of the project (its own when `environmentId` is undefined). */
	writeDesign(input: {
		projectId: string;
		environmentId: string | undefined;
		design: ValidDesign;
		keyHash: string;
	}): Promise<DesignWriteResult<null>>;
	/** Creates a project from `design`. */
	createProject(input: { design: ValidDesign; keyHash: string }): Promise<DesignWriteResult<{ projectId: string }>>;
}

/** The declared design tools this module serves. */
export const DESIGN_TOOL_NAMES = [
	"validate_design",
	"apply_design_patch",
	"create_project",
] as const satisfies readonly ExternalToolName[];

/** One of {@link DESIGN_TOOL_NAMES}. */
export type DesignToolName = (typeof DESIGN_TOOL_NAMES)[number];

/** True for a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every problem the board's validator finds in `design`, each with its JSON Pointer. */
export function validateDesign(design: unknown): { ok: true; design: ValidDesign } | { ok: false; errors: DesignProblem[] } {
	const parsed = designSaveSchema.safeParse(design);
	if (parsed.success) return { ok: true, design: parsed.data };
	return {
		ok: false,
		errors: parsed.error.issues.map((issue) => ({
			path: formatPointer(issue.path.map(String)),
			code: issue.code,
			message: issue.message,
			fix: null,
		})),
	};
}

/** A refusal from a design write as the one design error it is. */
function writeRefusal(path: string, message: string): DesignProblem {
	return { path, code: "refused", message, fix: null };
}

/** The design tool handlers, over `deps`. */
export function createDesignHandlers(deps: DesignDeps): Record<DesignToolName, HandledTool> {
	return {
		validate_design: served(EXTERNAL_TOOLS.validate_design, async ({ design }) => {
			const result = validateDesign(design);
			return result.ok ? { valid: true, errors: [] } : { valid: false, errors: result.errors };
		}),

		apply_design_patch: served(EXTERNAL_TOOLS.apply_design_patch, async (input, ctx) => {
			const { project_id: projectId, environment_id: environmentId, base_revision: baseRevision } = input;
			const keyHash = deps.keyHash(ctx.actor, input.idempotency_key);
			// The read authorizes the caller for the project before anything else about it is read.
			const design = await deps.readDesign(projectId, environmentId);
			const repeated = await deps.findKeyedWrite(ctx.actor, projectId, keyHash);
			if (repeated !== null) {
				return { status: "applied" as const, revision: repeated, current_revision: null, errors: [], pull_request_url: null };
			}
			const current = await deps.designRevision(ctx.actor, projectId);
			if (current !== baseRevision) {
				return { status: "conflict" as const, revision: null, current_revision: current, errors: [], pull_request_url: null };
			}
			const patched = applyJsonPatch(z.json().parse(JSON.parse(JSON.stringify(design))), input.patch);
			const invalid = (errors: DesignProblem[]) => ({
				status: "invalid" as const,
				revision: null,
				current_revision: null,
				errors,
				pull_request_url: null,
			});
			if (!patched.ok) return invalid([patched.problem]);
			const validated = validateDesign(patched.document);
			if (!validated.ok) return invalid(validated.errors);
			const written = await deps.writeDesign({ projectId, environmentId, design: validated.design, keyHash });
			if (!written.ok) return invalid([writeRefusal("", written.error)]);
			const revision = (await deps.findKeyedWrite(ctx.actor, projectId, keyHash)) ?? (await deps.designRevision(ctx.actor, projectId));
			return { status: "applied" as const, revision, current_revision: null, errors: [], pull_request_url: null };
		}),

		create_project: served(EXTERNAL_TOOLS.create_project, async (input, ctx) => {
			const keyHash = deps.keyHash(ctx.actor, input.idempotency_key);
			const invalid = (errors: DesignProblem[]) => ({
				status: "invalid" as const,
				project_id: null,
				revision: null,
				errors,
			});
			const existing = await deps.findProjectByName(ctx.actor, input.name);
			if (existing !== null) {
				const repeated = await deps.findKeyedWrite(ctx.actor, existing, keyHash);
				if (repeated !== null) return { status: "created" as const, project_id: existing, revision: repeated, errors: [] };
				return invalid([
					{
						path: "/name",
						code: "name_taken",
						message: `A project named ${input.name.trim()} already exists in this organization.`,
						fix: "Choose another name.",
					},
				]);
			}
			// The name argument is the project's name; the design's own, if any, is replaced by it.
			const project = isRecord(input.design.project) ? input.design.project : {};
			const validated = validateDesign({ ...input.design, project: { ...project, project_name: input.name } });
			if (!validated.ok) return invalid(validated.errors);
			const created = await deps.createProject({ design: validated.design, keyHash });
			if (!created.ok) return invalid([writeRefusal("", created.error)]);
			const { projectId } = created.value;
			const revision = (await deps.findKeyedWrite(ctx.actor, projectId, keyHash)) ?? 0;
			return { status: "created" as const, project_id: projectId, revision, errors: [] };
		}),
	};
}
