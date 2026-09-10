"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useState } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { NodeKind } from "@/components/design-project/canvas/graph/types";

/** The inspector tabs a card can be showing. */
export const INSPECTOR_TABS = [
	"overview",
	"cost",
	"activity",
	"deploy",
	"settings",
] as const;

export type InspectorTab = (typeof INSPECTOR_TABS)[number];

/** Narrows the tab component's `string` callback to a tab this store can remember. */
export function isInspectorTab(value: string): value is InspectorTab {
	return INSPECTOR_TABS.some((tab) => tab === value);
}

interface InspectorPrefsStore {
	/** Which config sections are expanded, keyed `${kind}:${sectionId}`. */
	openSections: Record<string, boolean>;
	/** Which tab each kind's card was last left on. */
	tab: Partial<Record<NodeKind, InspectorTab>>;
	setSectionOpen: (kind: NodeKind, sectionId: string, open: boolean) => void;
	setTab: (kind: NodeKind, tab: InspectorTab) => void;
}

/**
 * How the user likes their component cards laid out — which sections are open, which tab each
 * kind's card sits on.
 *
 * These lived in component-local `useState`, so every one of them reset the moment the card
 * unmounted: open Advanced on a database, click the board, come back — collapsed again, and the
 * knob you were three edits into is behind a chevron. A preference about how you work is not a
 * fact about the design, so it is persisted per browser (localStorage) and never touches the
 * canvas draft, the diff or the deploy snapshot.
 */
export const useInspectorPrefsStore = create<InspectorPrefsStore>()(
	persist(
		(set) => ({
			openSections: {},
			tab: {},
			setSectionOpen: (kind, sectionId, open) =>
				set((s) => ({
					openSections: { ...s.openSections, [`${kind}:${sectionId}`]: open },
				})),
			setTab: (kind, tab) => set((s) => ({ tab: { ...s.tab, [kind]: tab } })),
		}),
		{
			name: "alethia-inspector-prefs",
			storage: createJSONStorage(() => localStorage),
			version: 1,
		},
	),
);

/**
 * Whether a section is expanded: the user's recorded choice if they have made one for this
 * (kind, section), else the schema's own default. A section is remembered per KIND rather than
 * per node, because "I always want a database's Advanced open" is the preference people actually
 * have — not "…on this one database".
 *
 * `kind` is optional because `ConfigFields` is — the add palette's quick-config and any surface
 * that wants no inline validation omit it. Without a kind there is nothing to remember the
 * preference UNDER, so the section falls back to component state: it still opens and closes, it
 * simply does not outlive the card. It must not silently refuse to open, which is what a
 * store-only setter did.
 */
export function useSectionOpen(
	kind: NodeKind | undefined,
	sectionId: string,
	defaultOpen: boolean,
): [boolean, (open: boolean) => void] {
	const stored = useInspectorPrefsStore((s) =>
		kind ? s.openSections[`${kind}:${sectionId}`] : undefined,
	);
	const setSectionOpen = useInspectorPrefsStore((s) => s.setSectionOpen);
	const [local, setLocal] = useState(defaultOpen);
	if (!kind) return [local, setLocal];
	return [
		stored ?? defaultOpen,
		(open: boolean) => setSectionOpen(kind, sectionId, open),
	];
}
