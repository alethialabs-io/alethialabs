// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Next runs this file in the browser before hydration. Its one job here is the route hairline's
// start signal: `onRouterTransitionStart` is the only framework hook that sees EVERY App Router
// navigation (a `<Link>`, `router.push`/`replace`, back/forward), where `useLinkStatus` sees only
// the link it is rendered inside. See components/shell/route-progress.tsx. Keep it this small —
// Next warns when this file's evaluation takes longer than 16ms.

import { signalRouteTransitionStart } from "@/components/shell/route-progress";

/** Next's App Router navigation-start hook: hands the destination to the route hairline. */
export function onRouterTransitionStart(url: string): void {
	signalRouteTransitionStart(url);
}
