// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { RunnersSkeleton } from "@/components/runners/runners-skeleton";
import { SkeletonRoot } from "@/components/skeleton/skeleton-root";
import { deploymentMode } from "@/lib/billing/config";

/**
 * What the runners route shows before the server has decided what the page IS (F021).
 *
 * The page is plan-gated, but only on a HOSTED deployment: there a plan without BYO runners renders
 * an upsell card, every other viewer the pools / versions / runner grid. Which one is a per-org fact
 * this file cannot know — it is the instant fallback Next shows on navigation, before `page.tsx` has
 * resolved the actor — so on a hosted deployment it promises neither shape: a busy region and
 * nothing in it. A self-managed deployment is never gated (`page.tsx`), and the deployment mode is
 * configuration read synchronously, so there the answer is already known and this draws the page's
 * own skeleton (RUBRIC skeleton rule 3: the same gate as the page, resolved without a wait).
 */
export default function RunnersLoading() {
	if (deploymentMode() !== "hosted") return <RunnersSkeleton hosted={false} />;
	return (
		<SkeletonRoot>
			<span className="sr-only">Loading runners</span>
		</SkeletonRoot>
	);
}
