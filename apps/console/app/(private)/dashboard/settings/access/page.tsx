"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { AccessManager } from "@/components/settings/access/access-manager";

/** Access — fine-grained grants (member/team → role or permission, scoped). Enterprise. */
export default function AccessPage() {
	return <AccessManager />;
}
