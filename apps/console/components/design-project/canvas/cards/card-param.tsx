// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useEffect } from "react";
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

/**
 * Consume a `?card=` deep link once and strip it from the address bar.
 *
 * This is a hook of its own, rather than an effect inside the canvas, because both halves are
 * ordering decisions that a reader would otherwise have to rediscover — and both were wrong in a
 * way that produced the identical, uninformative symptom: the link resolved, the param vanished,
 * and the rail stayed shut.
 *
 * `queueMicrotask` — the canvas is a CHILD of the workbench, and React flushes a child's passive
 * effects before its parent's. The workbench seeds the graph on mount with `setGraph`, which clears
 * the open card, so opening it straight from this effect is undone microseconds later by a parent
 * that never knew a link asked for anything. A microtask runs after the whole flush, once the seed
 * has already happened.
 *
 * `history.replaceState` rather than `router.replace` — the router's version is a NAVIGATION. It
 * re-renders the server component, hands the workbench a fresh `sourceProject` object, and re-runs
 * its seeding effect, clearing the card a second time for a URL change the user did not make.
 * Editing the address bar directly is all this needs: nothing reads `?card=` after this hook has
 * consumed it.
 */
export function useCardDeepLink(
	// Structural rather than `URLSearchParams`, so Next's read-only flavour and a plain one both
	// fit and a test needs no framework to drive it.
	search: { get(name: string): string | null; toString(): string },
	openCard: (card: WorkspaceCard) => void,
): void {
	useEffect(() => {
		const target = parseCardParam(search.get("card"));
		if (!target) return;
		queueMicrotask(() => openCard(target));
		const rest = new URLSearchParams(search.toString());
		rest.delete("card");
		const query = rest.toString();
		window.history.replaceState(
			null,
			"",
			`${window.location.pathname}${query ? `?${query}` : ""}`,
		);
	}, [search, openCard]);
}
