// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";
import type { UIMessage } from "ai";
import type { AiMessage } from "@/lib/analytics/server";

// Helpers to shape AI SDK chat data into PostHog's `$ai_input` / `$ai_output_choices` convention
// ({role, content}) for LLM-analytics enrichment. Kept out of lib/analytics/server.ts so that module
// stays free of the `ai` SDK dependency (it also runs from the non-Next migrate context).

/** Flatten a UIMessage's text parts into a single string (drops tool/reasoning/file parts). */
function uiMessageText(message: UIMessage): string {
	if (!Array.isArray(message.parts)) return "";
	let text = "";
	for (const part of message.parts) {
		if (part.type === "text" && typeof part.text === "string") text += part.text;
	}
	return text;
}

/** Map UI chat messages to PostHog's `$ai_input` shape ({role, content}). */
export function uiMessagesToAiInput(messages: UIMessage[]): AiMessage[] {
	return messages.map((m) => ({ role: m.role, content: uiMessageText(m) }));
}

/** Wrap the model's final text as a single assistant output choice for `$ai_output_choices`. */
export function textToAiOutput(text: string): AiMessage[] {
	return text ? [{ role: "assistant", content: text }] : [];
}
