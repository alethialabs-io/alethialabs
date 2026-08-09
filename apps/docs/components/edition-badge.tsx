// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactNode } from "react";

const base =
	"inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium align-middle whitespace-nowrap";

/** Marks a feature/section as part of the licensed Enterprise edition. */
export function Enterprise({ children }: { children?: ReactNode }) {
	return (
		<span
			className={`${base} border-fd-border bg-fd-muted text-fd-foreground`}
		>
			{children ?? "Enterprise"}
		</span>
	);
}

/** Marks a feature/section as part of the free, open-source Community edition. */
export function Community({ children }: { children?: ReactNode }) {
	return (
		<span
			className={`${base} border-fd-border border-dashed bg-transparent text-fd-muted-foreground`}
		>
			{children ?? "Open-source"}
		</span>
	);
}
