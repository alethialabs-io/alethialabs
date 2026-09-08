// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { UIMessage } from "ai";
import { z } from "zod";
import type { CanvasContext } from "@/lib/ai/canvas-context";
import { mentionsSchema } from "@/lib/ai/mentions";

/**
 * What the user is looking at when they send a project-assistant message — the route surface and,
 * on Architecture, the card open on the workspace rail. The canvas snapshot already says which node
 * is selected; this says where in the product the user is, so "what's going on here" can be
 * answered about the Jobs page as readily as about the board.
 */
export const assistantViewSchema = z.object({
	/** The route pathname, for the model's orientation only (never re-navigated). */
	path: z.string().max(512),
	surface: z
		.enum(["architecture", "environments", "jobs", "clusters", "settings", "usage", "other"])
		.catch("other"),
	/** The card on the workspace rail, when one is open. */
	openCard: z
		.object({
			kind: z.string().max(64),
			name: z.string().max(200).optional(),
		})
		.optional(),
});

export type AssistantView = z.infer<typeof assistantViewSchema>;

/**
 * The project-assistant request body (`POST /api/projects/[projectId]/assistant`), shared by the
 * client (`prepareBody`) and the route so the two cannot drift apart.
 *
 * `environmentId` is the environment the conversation is scoped to. It is `.catch(null)` rather
 * than rejected: a malformed id degrades to "the project's default environment" — which the route
 * resolves server-side under the caller's org, so a foreign id can never be reached from here.
 */
export const projectAssistantBodySchema = z.object({
	messages: z.array(z.custom<UIMessage>()),
	/** Live canvas snapshot when the canvas is active (undefined elsewhere). */
	canvas: z.custom<CanvasContext>().optional(),
	/** When set, the transcript is persisted to this (project-scoped) thread on finish. */
	threadId: z.string().optional(),
	/** Resources the user @-referenced in the latest message. A malformed list is dropped rather
	 * than rejected — the route degraded it that way before this schema existed, and losing the
	 * @-mentions is a smaller failure than losing the turn. */
	mentions: mentionsSchema.catch(undefined),
	/**
	 * Per-message opt-in to the Opus advisor ("deep reasoning"). Only effective on `ai_max`
	 * (the advisor selection guards it); ignored on every other tier.
	 */
	deepReasoning: z.boolean().catch(false),
	environmentId: z.string().uuid().nullable().catch(null),
	view: assistantViewSchema.optional(),
});

export type ProjectAssistantBody = z.infer<typeof projectAssistantBodySchema>;

/**
 * Parse a request body, degrading rather than throwing wherever the route used to.
 *
 * The route destructured an untyped interface before this schema existed, so a body it could not
 * make sense of still produced a turn. A bare `.parse()` here would be strictly stricter — an
 * unexpected shape would throw out of the handler and 500 the whole turn, after the AI budget hold
 * was already reserved. Only `messages` is genuinely required; everything else has a fallback.
 */
export function parseProjectAssistantBody(
	body: unknown,
): { ok: true; value: ProjectAssistantBody } | { ok: false; message: string } {
	const parsed = projectAssistantBodySchema.safeParse(body);
	if (parsed.success) return { ok: true, value: parsed.data };
	const first = parsed.error.issues[0];
	return {
		ok: false,
		message: first
			? `${first.path.join(".") || "body"}: ${first.message}`
			: "Malformed request body.",
	};
}
