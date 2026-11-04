// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";
import { randomUUID } from "node:crypto";

declare global {
	var __alethiaBootId: string | undefined;
}

/**
 * This process's boot id, sent in every stream's `hello` (#6115, ADR 0005 §10 R9).
 *
 * A stream's cursor counts notices THIS process heard, so it means nothing to another process. A
 * client whose reconnect lands on a different boot — a deploy, a restart, another replica behind a
 * load balancer — cannot compare cursors and resyncs once, with jitter, instead of every tab
 * refetching everything the instant the deploy lands. On globalThis so every bundled module
 * instance in one process agrees on it.
 */
export function bootId(): string {
	globalThis.__alethiaBootId ??= randomUUID();
	return globalThis.__alethiaBootId;
}
