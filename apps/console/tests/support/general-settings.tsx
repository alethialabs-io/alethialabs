// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The General settings pages as their routes hand them to the browser (#6128): a QueryClient
// already holding the read the page prefetched, exactly as `HydrationBoundary` leaves it — so a
// test renders the form's FIRST paint, with no fetch, the way a user sees it.
//
// A caller must mock `next/navigation` (the mutations route) and the two action modules, as every
// test of these forms does; this file decides only what the read answered.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { OrgGeneral } from "@/components/settings/general/org-general";
import { ProjectGeneral } from "@/components/settings/general/project-general";
import type { OrgSettings } from "@/lib/org/settings";
import { orpc } from "@/lib/rpc/client";
import type { OrgGeneralRead, ProjectGeneral as ProjectGeneralRow } from "@/lib/rpc/procedures/settings";

/** The org the fixtures render. */
export const ACME: OrgSettings = {
	name: "Acme",
	slug: "acme",
	logo: null,
	description: "",
	primaryAddress: null,
	region: "eu-west-1",
	defaultEnv: "production",
	terraformVersion: "1.9.0",
};

/** The project the fixtures render (its id is a uuid: the rename action validates one). */
export const MY_APP: ProjectGeneralRow = {
	id: "5f0c4b8e-2d1a-4c3b-9e7f-0a1b2c3d4e5f",
	project_name: "My App",
	slug: "my-app",
};

/** A client that never refetches on its own, so what a test seeds is what the page renders. */
export function seededClient(): QueryClient {
	return new QueryClient({
		defaultOptions: {
			queries: { staleTime: Number.POSITIVE_INFINITY, retry: false, retryOnMount: false },
			mutations: { retry: false },
		},
	});
}

/** `ui` inside a provider for a fresh {@link seededClient} — for a form whose mutation needs one. */
export function withQueryClient(ui: ReactElement, client: QueryClient = seededClient()): ReactElement {
	return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

/** Renders the org General page with `read` as the hydrated `settings.org` answer. */
export function renderOrgGeneral(
	read: OrgGeneralRead = { scope: "organization", settings: ACME },
	client: QueryClient = seededClient(),
) {
	client.setQueryData(orpc.settings.org.queryKey(), read);
	return mountOrgGeneral(client);
}

/** Renders the org General page over `client` as it stands (seeded, failed or empty). */
export function mountOrgGeneral(client: QueryClient) {
	const utils = render(
		<QueryClientProvider client={client}>
			<OrgGeneral />
		</QueryClientProvider>,
	);
	return { client, ...utils };
}

/** Renders the project General page with `row` as the hydrated `settings.project` answer. */
export function renderProjectGeneral(
	row: ProjectGeneralRow | null = MY_APP,
	client: QueryClient = seededClient(),
) {
	client.setQueryData(PROJECT_KEY, row);
	return mountProjectGeneral(client);
}

/** The `settings.project` key the fixtures' page reads. */
export const PROJECT_KEY = orpc.settings.project.queryKey({ input: { project: "my-app" } });

/** Renders the project General page over `client` as it stands (seeded, failed or empty). */
export function mountProjectGeneral(client: QueryClient) {
	const utils = render(
		<QueryClientProvider client={client}>
			<ProjectGeneral project="my-app" orgSlug="acme" />
		</QueryClientProvider>,
	);
	return { client, ...utils };
}

/**
 * Puts a read into the FAILED state a refused or broken server prefetch leaves on the client: no
 * data, an error, nothing in flight. `retryOnMount: false` (see {@link seededClient}) keeps it there,
 * so the test sees the render the user sees once the client's own retry has answered the same.
 */
export function failRead(client: QueryClient, queryKey: readonly unknown[], error: Error): void {
	const query = client.getQueryCache().build(client, { queryKey: [...queryKey] });
	query.setState({
		...query.state,
		status: "error",
		fetchStatus: "idle",
		error,
		errorUpdatedAt: Date.now(),
		errorUpdateCount: 1,
	});
}
