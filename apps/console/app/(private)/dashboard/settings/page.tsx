// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from "next/navigation";

/** /dashboard/settings → the first section (Roles is available in every edition). */
export default function SettingsIndex() {
	redirect("/dashboard/settings/roles");
}
