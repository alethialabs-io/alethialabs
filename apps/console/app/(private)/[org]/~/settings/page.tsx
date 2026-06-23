// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from "next/navigation";

/** /{org}/~/settings → the first section (Roles is available in every edition). */
export default async function SettingsIndex({
	params,
}: {
	params: Promise<{ org: string }>;
}) {
	const { org } = await params;
	redirect(`/${org}/~/settings/roles`);
}
