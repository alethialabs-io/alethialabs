// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The ephemeral PR-preview-environments (W-f, #842) feature flag, in a plain module (not a
// "use server" file) so both server actions and server components can import this synchronous
// check. Off by default: the runner half (installing the preview ApplicationSet + seeding the SCM
// token Secret on the Fabric) lands separately, so enabling it early only surfaces the resolver
// that computes a Fabric's preview configuration from the data model — no preview is created yet.

/** Whether ephemeral PR-preview environments are enabled on this deployment (server-side env flag). */
export function isPreviewEnvsEnabled(): boolean {
	return process.env.ALETHIA_PREVIEW_ENVS_ENABLED === "true";
}
