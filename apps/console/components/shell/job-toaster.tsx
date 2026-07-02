"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useJobToasts } from "@/hooks/use-job-toasts";

/**
 * Headless mount point for the job-lifecycle toast driver. Rendered once by the app shell so
 * `useJobToasts` has a single instance (the source of dedup) with access to the org slug for
 * client-side "View job" navigation. Renders nothing.
 */
export function JobToaster() {
	useJobToasts();
	return null;
}
