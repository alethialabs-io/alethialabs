// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The bring-your-own-IaC (E3) feature flag, in a plain module (not a "use server" file) so both
// the server actions and server components can import this synchronous check. Server actions
// still enforce it — this only governs UI visibility. Off by default: the runner half (IAC_SCAN
// execution + replace-mode provisioning) lands separately, so enabling it early only exposes
// attach/scan plumbing that queues jobs no runner executes yet.

/** Whether the BYO-IaC feature is enabled on this deployment (server-side env flag). */
export function isByoIacEnabled(): boolean {
	return process.env.ALETHIA_BYO_IAC_ENABLED === "true";
}
