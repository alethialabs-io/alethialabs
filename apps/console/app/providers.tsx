// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import type React from "react";
import { getQueryClient } from "@/lib/query/client";

/**
 * Client-side data layer. Wraps the app in a single QueryClient (request-scoped on the
 * server, singleton in the browser via `getQueryClient`) so server-prefetched data
 * hydrates into the same cache the client reads. Devtools render in development only.
 */
export function Providers({ children }: { children: React.ReactNode }) {
	const queryClient = getQueryClient();
	return (
		<QueryClientProvider client={queryClient}>
			{children}
			{process.env.NODE_ENV === "development" ? (
				<ReactQueryDevtools initialIsOpen={false} buttonPosition="bottom-left" />
			) : null}
		</QueryClientProvider>
	);
}
