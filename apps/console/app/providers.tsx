// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import type React from "react";
import { ConsentProvider } from "@repo/privacy/consent-provider";
import { getQueryClient } from "@/lib/query/client";
import { tenantSegment } from "@/lib/rpc/client";
import { AnalyticsProvider } from "@/components/providers/analytics-provider";
import { legalUrl } from "@/lib/legal";

/**
 * Client-side data layer. Wraps the app in a QueryClient that is request-scoped on the server and,
 * in the browser, ONE PER TENANT — keyed on the URL's first segment (`/acme/…`, `~` for personal) —
 * so server-prefetched data hydrates into the cache the client reads and a client-side org switch
 * can never render another org's cached rows (#6113, ADR 0005 stress test R1). Devtools render in development only.
 * ConsentProvider keeps optional product analytics and session replay off until the visitor makes
 * the matching choice. AnalyticsProvider then mounts only providers configured via runtime env.
 */
export function Providers({ children }: { children: React.ReactNode }) {
	const queryClient = getQueryClient(tenantSegment(usePathname()));
	return (
		<ConsentProvider cookieNoticeHref={legalUrl("/cookies")}>
			<QueryClientProvider client={queryClient}>
				<AnalyticsProvider>{children}</AnalyticsProvider>
				{/* Bottom-right: bottom-left sits on top of the sidebar profile. */}
				{process.env.NODE_ENV === "development" ? (
					<ReactQueryDevtools
						initialIsOpen={false}
						buttonPosition="bottom-right"
					/>
				) : null}
			</QueryClientProvider>
		</ConsentProvider>
	);
}
