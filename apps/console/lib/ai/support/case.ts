// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";

/**
 * The support-case schemas the Ask-AI assistant reasons over. These MIRROR the
 * server-side `submitCaseSchema` (`@/lib/validations/support`, owned by the support
 * actions surface) so the assistant's `create_support_case` proposal lines up with
 * what `submitCase(...)` accepts — but they live here so the tool + the client
 * approval card share one source without importing the server action's validation.
 * `create_support_case` is HITL: the model PROPOSES a case; `submitCase` runs on the
 * user's approval click (mirrors `operation.ts` / the plan/deploy approval pattern).
 */

// Enum tuples are kept in lockstep with the DB enums (lib/db/schema/enums.ts) so a
// proposal always maps 1:1 onto `submitCaseSchema`. If those enums change, update here.

/** What kind of case this is (routes it to the right queue). Mirrors `supportCaseType`. */
export const supportCaseTypeSchema = z.enum([
	"technical",
	"billing",
	"account",
	"general",
	"abuse",
]);

/** The product area the case is about. Mirrors `supportCaseCategory`. */
export const supportCaseCategorySchema = z.enum([
	"clusters",
	"jobs",
	"runners",
	"connectors",
	"networking",
	"billing_invoices",
	"account_access",
	"quotas_limits",
	"api_cli",
	"agent_ai",
	"other",
]);

/** How urgent the case is (drives triage priority). Mirrors `supportCaseSeverity`. */
export const supportCaseSeveritySchema = z.enum([
	"low",
	"normal",
	"high",
	"urgent",
]);

/**
 * Optional account context the assistant looked up (ids it read via the tools), so a
 * human can jump straight to the resource. Matches the `SupportCaseContext` jsonb shape
 * — a known shape, never `Record<string, unknown>`.
 */
export const supportCaseContextSchema = z.object({
	projectId: z.string().optional(),
	clusterId: z.string().optional(),
	jobId: z.string().optional(),
	connectorId: z.string().optional(),
	region: z.string().optional(),
	consoleUrl: z.string().optional(),
	userAgent: z.string().optional(),
});

/** Input the assistant passes to `create_support_case` (mirrors `submitCaseSchema`). */
export const createSupportCaseInputSchema = z.object({
	type: supportCaseTypeSchema,
	category: supportCaseCategorySchema,
	severity: supportCaseSeveritySchema.default("normal"),
	subject: z
		.string()
		.min(3)
		.max(120)
		.describe("Short imperative summary of the issue."),
	description: z
		.string()
		.min(10)
		.describe(
			"What the user is trying to do, what happened, and what you already checked.",
		),
	context: supportCaseContextSchema.optional(),
});

/** The emitted proposal (tool output) the support approval card parses + submits. */
export const supportCaseProposalSchema = createSupportCaseInputSchema.extend({
	id: z.string(),
});

export type CreateSupportCaseInput = z.infer<typeof createSupportCaseInputSchema>;
export type SupportCaseProposal = z.infer<typeof supportCaseProposalSchema>;
