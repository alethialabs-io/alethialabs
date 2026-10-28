// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The posture table's geometry, shared by the table (`evidence-table.tsx`) and its loading form
// (`evidence-skeleton.tsx`). No "use client", deliberately: the route's `loading.tsx` is a server
// component, and a server component that imports a plain string from a "use client" module gets a
// client reference, not the string — so the skeleton could not read these if the table owned them.

import { cn } from "@repo/ui/utils";

/**
 * The width of each column, set on its HEADER cell. The environment column has none: it takes
 * whatever the others leave (`evidence-table.tsx` says why these are not a `<colgroup>`).
 */
export const EVIDENCE_COLUMNS = {
	environment: "",
	verify: "w-[128px]",
	drift: "w-[116px]",
	security: "w-[150px]",
	receipt: "w-[104px]",
	checked: "w-[116px]",
	open: "w-[36px]",
} as const;

/** Column count — the project group header row spans exactly this. */
export const EVIDENCE_COLUMN_COUNT = Object.keys(EVIDENCE_COLUMNS).length;

/** Cell padding. Tighter than the shell default: seven dense columns share the width. */
export const EVIDENCE_CELL = "px-3 py-2.5 first:pl-4 last:pr-4";

/** The header cell treatment — mono micro-caps, shared by all seven columns. */
export const EVIDENCE_HEAD = cn(
	EVIDENCE_CELL,
	"h-auto font-mono text-ui-3xs font-normal uppercase tracking-[0.13em] text-text-tertiary",
);

/** The bordered card both the table and its skeleton sit in. */
export const EVIDENCE_CARD = "overflow-hidden rounded-lg border bg-surface shadow-sm";

/** The table's minimum width: below it the seven columns cannot all be legible. */
export const EVIDENCE_TABLE_MIN = "min-w-[860px]";
