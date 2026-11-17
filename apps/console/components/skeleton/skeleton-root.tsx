// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The root of every console skeleton (CON-SM7, #6759). The rules it belongs to are written in
// `docs/ui-conformance/RUBRIC.md`, "The skeleton rules".
//
// A skeleton's root says ONE thing to anything that is not looking at the pixels: this region is
// pending. The console said it two ways. Some roots carried `aria-busy`, which is that statement;
// others carried `aria-hidden`, which removes the region from the accessibility tree and so says
// nothing is there at all. The second form is also invisible to the audit's `settle()`
// (`e2e/audit/filters.ts`), which treats `aria-busy` as "not answered yet".
//
// No "use client": a skeleton renders from a route's `loading.tsx` and from a client panel while
// its read is pending, and this file must be importable from both.

import type { ComponentProps } from "react";

/**
 * What a skeleton root accepts: any `div` attribute except the three that decide how the region is
 * announced. `aria-busy` is this component's to set; `aria-hidden` contradicts it; and a `role`
 * would turn a pending region into a landmark or a live region, which is a different statement.
 */
export type SkeletonRootProps = Omit<ComponentProps<"div">, "aria-busy" | "aria-hidden" | "role">;

/**
 * The one wrapper a skeleton is drawn inside: a `div` carrying `aria-busy="true"` and
 * `data-slot="skeleton-root"`. Everything else — spacing, grid, width — is the caller's, through
 * `className` and the page's own primitives as children.
 */
export function SkeletonRoot({ children, ...props }: SkeletonRootProps) {
	return (
		<div {...props} data-slot="skeleton-root" aria-busy="true">
			{children}
		</div>
	);
}
