// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Where a `validation` result lands in a react-hook-form form. One function, so every form puts a
// server message under the field it is about, and a message about no visible field is still
// shown: in the form's root error, which `<FormRootError form={form} />` renders.

import type { FieldValues, Path, UseFormReturn } from "react-hook-form";
import type { FieldErrors } from "@/lib/actions/result";

/** The react-hook-form error key that holds server messages no field could take. */
export const ROOT_SERVER_ERROR = "root.server";

/** What {@link applyFieldErrors} could not place under a field. */
export interface FieldErrorOutcome {
	/** The server's field keys that are not in `known`. Their messages are in the root error. */
	unmapped: string[];
}

/**
 * Puts each server message under its field; anything unmapped goes to `root.server`.
 *
 * `known` is the list of field paths the form renders. A server key is matched to a path by
 * equality, so a key the form does not render is never written to a field nobody can see.
 * A field takes its first message. The root error takes the first message of every unmapped key,
 * joined with a space.
 */
export function applyFieldErrors<F extends FieldValues>(
	form: UseFormReturn<F>,
	fields: FieldErrors,
	known: readonly Path<F>[],
): FieldErrorOutcome {
	const unmapped: string[] = [];
	const rootMessages: string[] = [];
	for (const [key, messages] of Object.entries(fields)) {
		const message = messages?.[0];
		if (!message) continue;
		const path = known.find((p) => p === key);
		if (path) {
			form.setError(path, { type: "server", message });
			continue;
		}
		unmapped.push(key);
		rootMessages.push(message);
	}
	if (rootMessages.length > 0) {
		form.setError(ROOT_SERVER_ERROR, { type: "server", message: rootMessages.join(" ") });
	}
	return { unmapped };
}
