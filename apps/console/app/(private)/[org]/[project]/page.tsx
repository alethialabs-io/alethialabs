// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from "next/navigation";

/**
 * `/{org}/{project}` — the project has no plain landing surface; it redirects to its default view,
 * **Architecture** (the design canvas). The environment (`?environment_id=`) is carried through so a
 * deep link keeps its selected env; Architecture resolves the default env when it's absent.
 */
export default async function ProjectIndexPage({
	params,
	searchParams,
}: {
	params: Promise<{ org: string; project: string }>;
	searchParams: Promise<{ environment_id?: string | string[] }>;
}) {
	const { org, project } = await params;
	const sp = await searchParams;
	const envId =
		typeof sp.environment_id === "string" ? sp.environment_id : undefined;
	const query = envId ? `?environment_id=${encodeURIComponent(envId)}` : "";
	redirect(`/${org}/${project}/architecture${query}`);
}
