// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useEffect } from "react";
import type { InspectorTab, Subject, WorkspaceCard } from "@/lib/canvas/store/types";
import { subjectOfCard, tabOfCard } from "@/lib/canvas/store/view-store";

/**
 * The `?card=` deep-link grammar → a legacy rail card, or null for anything else.
 *
 *   card=activity        the environment's activity
 *   card=env-settings    the environment's settings
 *   card=iac-scan        the environment's sources
 *   card=node:<id>       a node
 *   card=addon:<id>      an add-on
 *   card=chart:<id>      a bring-your-own chart
 *
 * Read-only: the canvas consumes the param on mount and strips it, and never writes it back as
 * the subject changes (no history churn). A malformed value opens nothing rather than throwing.
 *
 * The answer is still the legacy card, because the canvas opens it through the view store's
 * `openCard`, which maps it onto the subject the inspector reads. {@link resolveCardParam} is the
 * same grammar answered as that subject.
 */
export function parseCardParam(value: string | null): WorkspaceCard | null {
	if (!value) return null;
	if (value === "activity") return { kind: "activity" };
	if (value === "env-settings") return { kind: "env-settings" };
	if (value === "iac-scan") return { kind: "iac-scan" };
	const sep = value.indexOf(":");
	if (sep <= 0) return null;
	const head = value.slice(0, sep);
	const id = value.slice(sep + 1);
	if (!id) return null;
	if (head === "node") return { kind: "inspector", nodeId: id };
	if (head === "addon") return { kind: "addon", itemId: id };
	if (head === "chart") return { kind: "chart-scan", chartId: id };
	return null;
}

/** What a `?card=` value shows in the inspector: the subject, and the tab it opens on. */
export interface CardParamTarget {
	subject: Subject;
	/** The tab the link names, or null for the subject's default. */
	tab: InspectorTab | null;
}

/**
 * A `?card=` value as the inspector's subject and tab, or null for a value that names nothing.
 * Every value {@link parseCardParam} accepts resolves here, so an old link keeps opening what it
 * always opened.
 */
export function resolveCardParam(value: string | null): CardParamTarget | null {
	const card = parseCardParam(value);
	const subject = subjectOfCard(card);
	return subject ? { subject, tab: tabOfCard(card) } : null;
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
 * effects before its parent's. The workbench seeds the graph on mount, which closes the inspector,
 * so opening it straight from this effect is undone microseconds later by a parent that never knew
 * a link asked for anything. A microtask runs after the whole flush, once the seed has already
 * happened.
 *
 * `history.replaceState` rather than `router.replace` — the router's version is a NAVIGATION. It
 * re-renders the server component, hands the workbench a fresh `sourceProject` object, and re-runs
 * its seeding effect, closing the inspector a second time for a URL change the person did not make.
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
