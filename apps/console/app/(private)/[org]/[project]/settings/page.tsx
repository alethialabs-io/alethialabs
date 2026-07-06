// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from "next/navigation";

/** /{org}/{project}/settings → General, the first project-scoped settings section. */
export default async function ProjectSettingsIndex({
	params,
}: {
	params: Promise<{ org: string; project: string }>;
}) {
	const { org, project } = await params;
	redirect(`/${org}/${project}/settings/general`);
}
