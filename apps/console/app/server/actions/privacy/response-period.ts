// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The statutory response period, in its own dependency-free module so the account dialog can quote
// the same number the server stores as a case's deadline. It cannot live in `cases.ts` or
// `self-serve.ts`: a `"use server"` module may export only async functions, and the ledger helpers
// in `ledger.ts` import the database, which a client component must not pull in.

/** The statutory period to answer, in days (GDPR art. 12(3): one month). */
export const PRIVACY_RESPONSE_DAYS = 30;
