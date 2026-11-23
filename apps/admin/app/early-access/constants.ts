// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Constants the Early Access staff form and its server actions share. Kept apart from data.ts, which
// holds the database connection, so the client form can import them.

/** The longest grant staff may give in one act, in days. A longer grant is a second act. */
export const MAX_GRANT_DAYS = 366;

/** The grant length the staff form starts at, in days. */
export const DEFAULT_GRANT_DAYS = 90;
