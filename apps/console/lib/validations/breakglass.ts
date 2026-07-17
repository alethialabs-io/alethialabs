// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Zod contracts for the break-glass HTTP surface. All user input is validated here before the
// dispatcher runs — no manual string matching.

import { z } from "zod";
import { breakglassAction, projectStatus } from "@/lib/db/schema/enums";

/** The typed action-input block (mirrors BreakglassActionInput in types/jsonb.types.ts). */
export const breakglassInputSchema = z
	.object({
		expectedFrom: z.array(z.enum(projectStatus.enumValues)).optional(),
		to: z.enum(projectStatus.enumValues).optional(),
		stateKey: z.string().optional(),
		fleetReason: z.string().optional(),
		projectId: z.string().uuid().optional(),
		environmentId: z.string().uuid().optional(),
		surgeryNote: z.string().max(2000).optional(),
		suppressEmails: z.boolean().optional(),
	})
	.strict();

/** Body for POST /api/breakglass/session — open a time-boxed session. */
export const openSessionSchema = z.object({
	reason: z.string().min(8).max(1000),
});

/** The dispatchable actions (everything except the session-open pseudo-action). */
const dispatchAction = z.enum(
	breakglassAction.enumValues.filter((a) => a !== "open_session") as [
		string,
		...string[],
	],
);

/** Body for POST /api/breakglass/approval — a second operator mints a two-person approval. */
export const mintApprovalSchema = z.object({
	action: dispatchAction,
	resourceId: z.string().min(1),
	reason: z.string().min(8).max(1000),
	input: breakglassInputSchema.optional(),
});

/** Body for POST /api/breakglass/execute — run one audited action. */
export const executeSchema = z.object({
	sessionId: z.string().uuid(),
	action: dispatchAction,
	resourceId: z.string().min(1).optional(),
	confirm: z.string().optional(),
	reason: z.string().min(8).max(1000),
	approvalId: z.string().uuid().optional(),
	input: breakglassInputSchema.optional(),
});

export type OpenSessionBody = z.infer<typeof openSessionSchema>;
export type MintApprovalBody = z.infer<typeof mintApprovalSchema>;
export type ExecuteBody = z.infer<typeof executeSchema>;
