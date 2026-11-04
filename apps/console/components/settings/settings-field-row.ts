// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The `SettingsField` row's geometry, in a module of its own because `settings-ui.tsx` is a client
// module: a plain value exported from a "use client" file reaches a server component (a route's
// `loading.tsx`) as a client reference, not as the string. Kept here, the form row and the loading
// skeletons that cannot take real labels read the SAME classes, so they cannot drift apart.

/**
 * A settings row: one column below the enclosing `SettingsPanel`'s 32rem container step (`@lg:`),
 * a `200px | 1fr` label | control grid from it (#6135). Render it inside a `SettingsPanel` — the
 * panel is the query container; outside one the row stays stacked at every width.
 */
export const SETTINGS_FIELD_ROW_CLASS =
	"grid grid-cols-1 items-start gap-2 border-b border-border px-[22px] py-[15px] last:border-b-0 @lg:grid-cols-[200px_1fr] @lg:gap-6";
