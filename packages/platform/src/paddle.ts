// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The shape of a Paddle customer id, shared by the staff app (which checks what the operator typed)
// and the console (which re-checks it at its own boundary before writing the billing row). Paddle's
// API reference documents customer ids as `ctm_` followed by 26 lowercase letters and digits.

/** A Paddle customer id: `ctm_` + 26 lowercase alphanumerics. */
export const PADDLE_CUSTOMER_ID_PATTERN = /^ctm_[a-z0-9]{26}$/;

/** The message shown when a value does not match {@link PADDLE_CUSTOMER_ID_PATTERN}. */
export const PADDLE_CUSTOMER_ID_HINT = "A Paddle customer id is ctm_ followed by 26 lowercase letters and digits.";
