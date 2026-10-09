"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Elench drafts root (ADR 0001 §7, §14 slice 9): the one drafts store of this tab, bound to the
// real transport, and kept running whether or not the Elench surface is open.
//
// What it binds:
// - the server actions of `app/server/actions/elench-drafts.ts` as the store's transport, and the
//   heartbeat route (`POST /api/elench/drafts/heartbeat`) over the browser's own `fetch` (D34);
// - `sessionStorage` as the cache, a tab id minted per page load (§7.1) and `crypto.randomUUID`.
//
// What it runs, mounted once in `AppShell`:
// - `LOAD` of the page's scope (D26), at first mount and on every scope change (D23);
// - `PAGE_ORG(null)` at once on Back/Forward (`popstate`, D29), and a fresh list once the page has
//   rendered, whose answer names the page's org again;
// - `VIEWER_CHANGE` from `useViewer()` (D25), so a session that ends any way at all clears the tab;
// - the window and document listeners (focus, online, visibility, pagehide) and whether the surface
//   is open (D12's `mounted`, the 60 s poll).
//
// The store outlives the `[org]` layout (§1): it is one per tab, not one per mount, so an org
// switch that remounts the shell keeps every word in memory. A test passes its own `tab`.

import { usePathname } from "next/navigation";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import {
	claimDraft,
	consumeDraft,
	discardDraft,
	listDrafts,
	releaseClaim,
	restoreDraft,
	saveDraft,
	startConversation,
} from "@/app/server/actions/elench-drafts";
import { useViewer } from "@/components/providers/viewer-provider";
import { fetchHeartbeat } from "@/lib/stores/elench-drafts/heartbeat";
import { scopeId } from "@/lib/stores/elench-drafts/reducer-drafting";
import {
	createDraftsStore,
	type DraftsStoreDeps,
	type DraftsStoreHandle,
	type DraftsTransport,
	type DraftUiEffect,
} from "@/lib/stores/elench-drafts/store";
import type { DraftScope } from "@/lib/stores/elench-drafts/types";
import { useElenchStore } from "@/lib/stores/use-elench-store";

/** The draft actions themselves (§4.2): the store's transport in the app. */
export const SERVER_TRANSPORT: DraftsTransport = {
	listDrafts,
	saveDraft,
	restoreDraft,
	discardDraft,
	claimDraft,
	consumeDraft,
	releaseClaim,
	startConversation,
};

/** One effect the store hands the conversation (it touches `useChat`, never the server). */
export type DraftUiListener = (effect: DraftUiEffect) => void;

/** A tab's drafts: the store, and the UI effects it asks the mounted conversation to run. */
export interface DraftsTab {
	store: DraftsStoreHandle;
	/** Adds a listener for the store's UI effects; returns its removal. */
	subscribeUi(listener: DraftUiListener): () => void;
}

/** Creates a tab's drafts over `deps`; the UI effects go to whichever conversation listens. */
export function createDraftsTab(deps: Omit<DraftsStoreDeps, "ui">): DraftsTab {
	const listeners = new Set<DraftUiListener>();
	const store = createDraftsStore({
		...deps,
		ui: (effect) => {
			for (const listener of [...listeners]) listener(effect);
		},
	});
	return {
		store,
		subscribeUi(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}

/** This tab's drafts, created at the first mount with a known viewer and kept for the page's life. */
let pageTab: DraftsTab | null = null;

/** The tab's drafts over the real transport, created once per page load (client only). */
function pageDrafts(viewerId: string): DraftsTab {
	pageTab ??= createDraftsTab({
		viewerId,
		transport: SERVER_TRANSPORT,
		heartbeat: fetchHeartbeat(),
		storage: () => window.sessionStorage,
		tabId: crypto.randomUUID(),
		mint: () => crypto.randomUUID(),
	});
	return pageTab;
}

const DraftsTabContext = createContext<DraftsTab | null>(null);

/** The tab's drafts, or null before the root has a viewer (and on the server). */
export function useDraftsTab(): DraftsTab | null {
	return useContext(DraftsTabContext);
}

/**
 * Mounts the tab's drafts store above the Elench surface. `pageOrgId` is the page's
 * `currentActor().orgId`; the anchor is the conversation's (`useElenchStore`'s `ctx`). `tab`
 * replaces the page's own store (tests).
 */
export function ElenchDraftsRoot({
	pageOrgId,
	tab: injected,
	children,
}: {
	pageOrgId: string | null;
	tab?: DraftsTab;
	children: ReactNode;
}) {
	const { viewer, isPending } = useViewer();
	const viewerId = viewer?.id ?? null;
	const [tab, setTab] = useState<DraftsTab | null>(injected ?? null);
	const open = useElenchStore((s) => s.open);
	const projectId = useElenchStore((s) => (s.ctx.kind === "project" ? s.ctx.projectId : null));
	const pathname = usePathname();
	// Set by Back/Forward, cleared once the page it lands on has asked for its org again.
	const popped = useRef(false);

	// The store exists once a viewer is known (never on the server); a later viewer is D25.
	useEffect(() => {
		if (isPending) return;
		if (tab === null) {
			if (viewerId !== null) setTab(pageDrafts(viewerId));
			return;
		}
		tab.store.dispatch({ type: "VIEWER_CHANGE", viewerId });
	}, [tab, viewerId, isPending]);

	useEffect(() => (tab === null ? undefined : tab.store.connect(window, document)), [tab]);

	useEffect(() => {
		tab?.store.setSurfaceOpen(open);
	}, [tab, open]);

	// D26 / D23: LOAD of the page's scope. A remount of the shell on the same scope lists nothing new.
	useEffect(() => {
		if (tab === null || pageOrgId === null) return;
		const scope: DraftScope = { orgId: pageOrgId, projectId };
		const shown = tab.store.view.getState().drafts.scope;
		if (shown !== null && scopeId(shown) === scopeId(scope)) return;
		tab.store.load(scope);
	}, [tab, pageOrgId, projectId]);

	// D29: Back/Forward may land on another org's page, so nothing is POSTed until a list names it.
	useEffect(() => {
		if (tab === null) return;
		const onPop = (): void => {
			popped.current = true;
			tab.store.dispatch({ type: "PAGE_ORG", orgId: null });
		};
		window.addEventListener("popstate", onPop);
		return () => window.removeEventListener("popstate", onPop);
	}, [tab]);

	// …and once the page it lands on has rendered, a list of that page's scope answers its org. A
	// scope change already listed (the LOAD above); a page of the same scope lists here.
	useEffect(() => {
		if (tab === null || pageOrgId === null || !popped.current) return;
		popped.current = false;
		const drafts = tab.store.view.getState().drafts;
		if (drafts.pageOrg !== null || drafts.scope === null) return;
		tab.store.load(drafts.scope);
	}, [tab, pageOrgId, projectId, pathname]);

	return <DraftsTabContext.Provider value={tab}>{children}</DraftsTabContext.Provider>;
}
