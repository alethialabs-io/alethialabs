// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The VIEW half of the canvas store (#6764): what the inspector shows, what is selected, and how
// the board is drawn. None of it is part of the design, the draft or the undo history — closing a
// card is not an edit, and undoing an edit does not reopen one.
//
// `subject` is the inspector's one input. The legacy rail `card` is kept beside it for the shell
// files that still read the six-member union: opening a card sets the subject it maps onto, and
// setting a subject sets the card that shows it, so the two cannot disagree while both exist.

import { createStore, type StoreApi } from "zustand/vanilla";
import type {
	CanvasNode,
	NodeKind,
} from "@/components/design-project/canvas/graph/types";
import { collectionNodeId, kindFromCollectionId } from "@/lib/canvas/collections";
import type {
	FieldFocus,
	InspectorTab,
	NodeViewFlags,
	PendingChange,
	Subject,
	WorkspaceCard,
} from "./types";

/** The review view: whether it is open, and the changes a "Run plan" saved while it was. */
export interface ReviewState {
	open: boolean;
	/** The changes the last "Run plan" saved, still listed under "Saved in this review". */
	saved: PendingChange[];
}

export interface ViewState {
	/** What the inspector shows; null when the rail is closed. */
	subject: Subject | null;
	/** The inspector tab asked for; null lets the inspector choose its default for the subject. */
	tab: InspectorTab | null;
	/** A field to scroll to and focus, set by the review view's "Go to". */
	focus: FieldFocus | null;
	review: ReviewState;
	/** The ids selected on the board. */
	selection: string[];
	/** React Flow's per-node flags, by node id. */
	nodeView: Record<string, NodeViewFlags>;
	showConnections: boolean;
	hiddenKinds: NodeKind[];
	handTool: boolean;
	/** The legacy rail card (see the header). */
	card: WorkspaceCard | null;
	/** The card a detour came from, or null. Cleared by any non-detour open. */
	cardBack: WorkspaceCard | null;
}

export interface ViewActions {
	/** Show `subject` in the inspector, on `tab` when one is given. Null closes the rail. */
	setSubject: (subject: Subject | null, tab?: InspectorTab) => void;
	setTab: (tab: InspectorTab | null) => void;
	/** Open the inspector on a node's Configure tab with one field to focus. */
	focusField: (nodeId: string, path: string) => void;
	clearFocus: () => void;
	openReview: () => void;
	closeReview: () => void;
	/** Record the changes a "Run plan" just saved, so the review view keeps listing them. */
	setReviewSaved: (saved: PendingChange[]) => void;
	setSelection: (ids: string[]) => void;
	setNodeView: (nodeView: Record<string, NodeViewFlags>) => void;
	toggleConnections: () => void;
	toggleKindVisibility: (kind: NodeKind) => void;
	setHandTool: (on: boolean) => void;
	/** Legacy: show a card on the rail. `back` remembers the card it replaced, for a detour. */
	openCard: (card: WorkspaceCard | null, options?: { back?: boolean }) => void;
	/** Legacy: return to the card a detour came from (no-op when there is none). */
	goBackCard: () => void;
	/**
	 * Open the inspector on node `id`, or close the rail with null. Unlike `openCard`, the card a
	 * detour came from is kept, so a node opened from the environment's settings can still go Back.
	 */
	openInspector: (id: string | null) => void;
	/**
	 * The node set changed (undo, redo, discard, remove, a moved server design). An inspector whose
	 * node is gone closes, the selection drops the ids that are gone, and everything else stays —
	 * undoing a move must not close the activity log.
	 */
	reconcile: (nodes: CanvasNode[], options?: { clearSelection?: boolean }) => void;
	/** Close the rail and drop the selection and the per-node flags: the view of another board. */
	reset: () => void;
}

export type ViewStore = StoreApi<ViewState & ViewActions>;

/** The subject a legacy card shows. */
export function subjectOfCard(card: WorkspaceCard | null): Subject | null {
	if (!card) return null;
	switch (card.kind) {
		case "inspector": {
			const nodeKind = kindFromCollectionId(card.nodeId);
			return nodeKind ? { kind: "collection", nodeKind } : { kind: "node", id: card.nodeId };
		}
		case "addon":
			return { kind: "node", id: `addon-${card.itemId}` };
		case "chart-scan":
			return { kind: "node", id: `chart-${card.chartId}` };
		case "env-settings":
		case "activity":
		case "iac-scan":
			return { kind: "environment" };
	}
}

/** The inspector tab a legacy card opens on, when it names one. */
export function tabOfCard(card: WorkspaceCard | null): InspectorTab | null {
	if (!card) return null;
	if (card.kind === "activity") return "activity";
	if (card.kind === "iac-scan") return "sources";
	if (card.kind === "chart-scan") return "status";
	return null;
}

/** The legacy card that shows a subject. A multi-selection has no card of its own. */
export function cardOfSubject(subject: Subject | null, tab: InspectorTab | null): WorkspaceCard | null {
	if (!subject) return null;
	switch (subject.kind) {
		case "node":
			return { kind: "inspector", nodeId: subject.id };
		case "collection":
			return { kind: "inspector", nodeId: collectionNodeId(subject.nodeKind) };
		case "environment":
			if (tab === "activity") return { kind: "activity" };
			if (tab === "sources") return { kind: "iac-scan" };
			return { kind: "env-settings" };
		case "selection":
			return null;
	}
}

/**
 * The card to keep after the node set changed. A non-inspector card is untouched; an inspector
 * survives only while its node — or, for a collection card, any member of its kind — is still on
 * the board.
 */
export function keepCard(card: WorkspaceCard | null, nodes: CanvasNode[]): WorkspaceCard | null {
	if (!card || card.kind !== "inspector") return card;
	if (nodes.some((n) => n.id === card.nodeId)) return card;
	const collection = kindFromCollectionId(card.nodeId);
	if (collection && nodes.some((n) => n.data.kind === collection)) return card;
	return null;
}

/** The subject to keep after the node set changed, by the same rule as {@link keepCard}. */
export function keepSubject(subject: Subject | null, nodes: CanvasNode[]): Subject | null {
	if (!subject) return null;
	switch (subject.kind) {
		case "environment":
			return subject;
		case "node":
			return nodes.some((n) => n.id === subject.id) ? subject : null;
		case "collection":
			return nodes.some((n) => n.data.kind === subject.nodeKind) ? subject : null;
		case "selection": {
			const ids = subject.ids.filter((id) => nodes.some((n) => n.id === id));
			if (ids.length === 0) return null;
			return ids.length === subject.ids.length ? subject : { kind: "selection", ids };
		}
	}
}

/** The view of a board nobody has opened anything on. */
function closedView(): Pick<
	ViewState,
	"subject" | "tab" | "focus" | "review" | "selection" | "nodeView" | "card" | "cardBack"
> {
	return {
		subject: null,
		tab: null,
		focus: null,
		review: { open: false, saved: [] },
		selection: [],
		nodeView: {},
		card: null,
		cardBack: null,
	};
}

/** Create a view store. One per board. */
export function createViewStore(): ViewStore {
	return createStore<ViewState & ViewActions>()((set) => ({
		...closedView(),
		// Edges are ON: a dependency graph you have to opt into isn't a dependency graph.
		showConnections: true,
		hiddenKinds: [],
		handTool: false,

		setSubject: (subject, tab) =>
			set({
				subject,
				tab: subject ? (tab ?? null) : null,
				focus: null,
				card: cardOfSubject(subject, tab ?? null),
				cardBack: null,
			}),

		setTab: (tab) => set({ tab }),

		focusField: (nodeId, path) =>
			set({
				subject: { kind: "node", id: nodeId },
				tab: "configure",
				focus: { nodeId, path },
				card: { kind: "inspector", nodeId },
				cardBack: null,
			}),

		clearFocus: () => set({ focus: null }),

		openReview: () => set((s) => ({ review: { ...s.review, open: true } })),
		closeReview: () => set((s) => ({ review: { ...s.review, open: false } })),
		setReviewSaved: (saved) => set((s) => ({ review: { ...s.review, saved } })),

		setSelection: (ids) => set({ selection: ids }),
		setNodeView: (nodeView) => set({ nodeView }),

		toggleConnections: () => set((s) => ({ showConnections: !s.showConnections })),
		toggleKindVisibility: (kind) =>
			set((s) => ({
				hiddenKinds: s.hiddenKinds.includes(kind)
					? s.hiddenKinds.filter((k) => k !== kind)
					: [...s.hiddenKinds, kind],
			})),
		setHandTool: (on) => set({ handTool: on }),

		openCard: (card, options) =>
			set((s) => ({
				card,
				cardBack: card && options?.back ? s.card : null,
				subject: subjectOfCard(card),
				tab: tabOfCard(card),
				focus: null,
			})),

		goBackCard: () =>
			set((s) =>
				s.cardBack
					? {
							card: s.cardBack,
							cardBack: null,
							subject: subjectOfCard(s.cardBack),
							tab: tabOfCard(s.cardBack),
						}
					: {},
			),

		openInspector: (id) => {
			const card: WorkspaceCard | null = id ? { kind: "inspector", nodeId: id } : null;
			set({ card, subject: subjectOfCard(card), tab: tabOfCard(card), focus: null });
		},

		reconcile: (nodes, options) =>
			set((s) => {
				const card = keepCard(s.card, nodes);
				// A card that survived keeps its subject; one that closed takes its subject with it. A
				// subject with no card (a multi-selection) is kept by its own rule.
				const subject = s.card ? (card ? s.subject : null) : keepSubject(s.subject, nodes);
				return {
					card,
					subject,
					tab: subject ? s.tab : null,
					focus: subject ? s.focus : null,
					selection: options?.clearSelection
						? []
						: s.selection.filter((id) => nodes.some((n) => n.id === id)),
				};
			}),

		reset: () => set(closedView()),
	}));
}
