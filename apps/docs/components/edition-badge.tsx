// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactNode } from "react";

const base =
	"inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium align-middle whitespace-nowrap";

/** Marks a feature/section as part of the licensed Enterprise edition. */
export function Enterprise({ children }: { children?: ReactNode }) {
	return (
		<span
			className={`${base} border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400`}
		>
			{children ?? "Enterprise"}
		</span>
	);
}

/** Marks a feature/section as part of the free, open-source Community edition. */
export function Community({ children }: { children?: ReactNode }) {
	return (
		<span
			className={`${base} border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400`}
		>
			{children ?? "Open-source"}
		</span>
	);
}
