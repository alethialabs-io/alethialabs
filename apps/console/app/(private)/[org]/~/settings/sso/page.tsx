// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { settledReadOf } from "@/components/settings/members/people-reads";
import { SsoManager } from "@/components/settings/sso/sso-manager";
import { SsoNoAccess } from "@/components/settings/sso/sso-no-access";
import { ssoQueryFromUrl } from "@/components/settings/sso/sso-filters";
import { FeatureUpsell } from "@/components/settings/upgrade/feature-upsell";
import { getQueryClient } from "@/lib/query/client";
import { paramReader } from "@/lib/query/filter-url-codec";
import { readRefusalOf, retryUnlessRefused } from "@/lib/rpc/refusal";
import { serverOrpc } from "@/lib/rpc/server";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "SSO · Settings",
	description: "Single sign-on (SAML / OIDC) for your organization.",
});

/**
 * `/{org}/~/settings/sso` — the org's identity providers (#6129, the jobs slice's shape).
 *
 * The bootstrap (entitlement, manage permission, the addressed org, the SP URLs) is read first and
 * alone, in-process through the read router: a viewer without `member:view` is refused there, once,
 * and gets the no-access render as their own state — not an empty list and not an error (B4).
 *
 * THE PLAN GATE IS DECIDED HERE, ON THE SERVER (#6132, F021): an org without the `sso` entitlement
 * gets the upsell as the page's whole body — no provider read prefetched, no toolbar, no filter bar
 * over it — and `loading.tsx` draws the same answer from the same request-cached actor.
 *
 * With the entitlement, the pristine provider list (the facet counts' universe) and the list for
 * the link's filters are prefetched, so the browser fetches nothing on mount (B1).
 */
export default async function SsoPage({
	searchParams,
}: {
	params: Promise<{ org: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const queryClient = getQueryClient();
	const rpc = serverOrpc();
	const boot = rpc.sso.bootstrap.queryOptions({ input: undefined, retry: retryUnlessRefused });
	await queryClient.prefetchQuery(boot);
	const state = queryClient.getQueryState(boot.queryKey);
	if (readRefusalOf(state?.error) === "forbidden") return <SsoNoAccess />;
	const bootstrap = queryClient.getQueryData(boot.queryKey);
	// A real failure (not a refusal) is the route's error boundary, never an empty page.
	if (!bootstrap) throw state?.error ?? new Error("The SSO settings could not be read.");

	if (!bootstrap.sso) return <FeatureUpsell feature="sso" />;

	const filtered = ssoQueryFromUrl(paramReader(await searchParams));
	await Promise.all([
		queryClient.prefetchQuery(rpc.sso.providers.queryOptions({ input: {}, retry: retryUnlessRefused })),
		queryClient.prefetchQuery(rpc.sso.providers.queryOptions({ input: filtered, retry: retryUnlessRefused })),
	]);

	return (
		<HydrationBoundary state={dehydrate(queryClient, { shouldDehydrateQuery: settledReadOf("sso") })}>
			<SsoManager bootstrap={bootstrap} />
		</HydrationBoundary>
	);
}
