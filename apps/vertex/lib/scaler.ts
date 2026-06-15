// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/** Fire-and-forget ping to the Lambda scaler so it checks for queued jobs immediately. */
export function notifyScaler() {
	const url = process.env.SCALER_FUNCTION_URL;
	if (!url) return;
	fetch(url, { method: "POST" }).catch(() => {});
}
