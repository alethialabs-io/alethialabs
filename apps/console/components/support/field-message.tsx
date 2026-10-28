// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { cn } from "@repo/ui/utils";

/**
 * The line under a support form field that carries its validation message — ALWAYS rendered, one
 * line tall, empty while the field is valid. A message that mounts on demand pushes everything
 * below it down by a line, so the button the user was aiming at moves under the cursor between
 * the press and the release (F043). Reserving the line means the message appears in place.
 *
 * `id` lets the field point `aria-describedby` at it; the message is announced politely.
 */
export function FieldMessage({
	id,
	message,
	className,
}: {
	id?: string;
	message?: string;
	className?: string;
}) {
	return (
		<p
			id={id}
			aria-live="polite"
			data-slot="field-message"
			className={cn("min-h-4 text-xs text-destructive", className)}
		>
			{message ?? ""}
		</p>
	);
}
