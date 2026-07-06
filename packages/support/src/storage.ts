// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Storage constants for the support-cases feature, shared by the console (upload + customer
// download) and the admin app (staff download). The bucket name is the one place both apps
// must agree on, so it lives here rather than being duplicated per app.

/** Object-storage bucket holding support-case attachments (S3-compatible). */
export const SUPPORT_ATTACHMENTS_BUCKET = "support-attachments";
