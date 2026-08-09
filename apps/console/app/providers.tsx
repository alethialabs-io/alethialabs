// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import type React from "react";
import { ConsentProvider } from "@repo/privacy/consent-provider";
import { getQueryClient } from "@/lib/query/client";
import { AnalyticsProvider } from "@/components/providers/analytics-provider";
import { legalUrl } from "@/lib/legal";

/**
 * Client-side data layer. Wraps the app in a single QueryClient (request-scoped on the
 * server, singleton in the browser via `getQueryClient`) so server-prefetched data
 * hydrates into the same cache the client reads. Devtools render in development only.
 * ConsentProvider keeps optional product analytics and session replay off until the visitor makes
 * the matching choice. AnalyticsProvider then mounts only providers configured via runtime env.
 */
export function Providers({ children }: { children: React.ReactNode }) {
	const queryClient = getQueryClient();
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
