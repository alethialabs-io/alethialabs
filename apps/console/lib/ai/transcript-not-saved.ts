// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { log } from "@/lib/observability/log";

/**
 * The rejection handler for a chat route's fire-and-forget `saveThreadTranscript`. The stream has
 * already finished, so the client cannot be told; this makes the failure visible in the logs
 * instead of an unhandled rejection that names nothing. The user's turn is still on their screen.
 */
export function transcriptNotSaved(threadId: string): (err: unknown) => void {
	return (err: unknown) => {
		log.error("chat transcript was not saved; a reload will not show this turn", {
			thread_id: threadId,
			err,
		});
	};
}
