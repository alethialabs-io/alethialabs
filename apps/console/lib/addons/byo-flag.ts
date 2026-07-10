// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The bring-your-own-Helm feature flag, in a plain module (not a "use server" file) so both the
// server actions and server components (e.g. the Architecture page, to gate the ⌘K "Sources"
// entry) can import this synchronous check. Server actions still enforce it — this only governs UI
// visibility. Trusted-only MVP: off unless the operator opts in.

/** Whether the BYO-Helm feature is enabled on this deployment (server-side env flag). */
export function isByoHelmEnabled(): boolean {
	return process.env.ALETHIA_BYO_HELM_ENABLED === "true";
}
