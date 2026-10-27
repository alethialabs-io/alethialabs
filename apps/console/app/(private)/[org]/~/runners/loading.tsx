// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the runners route shows before the server has decided what the page IS (F021).
 *
 * The page is plan-gated: a hosted plan without BYO runners renders an upsell card, every other
 * viewer the pools / versions / runner grid. Which one is a per-org fact this file cannot know — it
 * is the instant fallback Next shows on navigation, before `page.tsx` has resolved the actor — so it
 * promises neither shape: a busy region and nothing in it. The page's own skeleton (the grid's real
 * layout) is the `<Suspense>` fallback `page.tsx` renders once the gate has said the grid is coming.
 * The gate itself is one membership lookup, so this is on screen for a moment, if at all.
 */
export default function RunnersLoading() {
	return (
		<div role="status" aria-busy="true">
			<span className="sr-only">Loading runners</span>
		</div>
	);
}
