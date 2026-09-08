// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { WorkspaceCard } from "@/lib/stores/use-canvas-store";

/**
 * The `?card=` deep-link grammar → a workspace card, or null for anything else.
 *
 *   card=activity        the environment's activity log
 *   card=env-settings    the environment settings card
 *   card=node:<id>       a node's inspector
 *   card=addon:<id>      an add-on's install config
 *
 * Read-only: the canvas consumes the param on mount and strips it, and never writes it back as
 * the card changes (no history churn). A malformed value opens nothing rather than throwing.
 */
export function parseCardParam(value: string | null): WorkspaceCard | null {
	if (!value) return null;
	if (value === "activity") return { kind: "activity" };
	if (value === "env-settings") return { kind: "env-settings" };
	const sep = value.indexOf(":");
	if (sep <= 0) return null;
	const head = value.slice(0, sep);
	const id = value.slice(sep + 1);
	if (!id) return null;
	if (head === "node") return { kind: "inspector", nodeId: id };
	if (head === "addon") return { kind: "addon", itemId: id };
	return null;
}
