"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { QueryClientProvider } from "@tanstack/react-query";
import type React from "react";
import { getQueryClient } from "@/lib/query-client";

/**
 * The client-side data layer for the admin app. Wraps the tree in a single
 * QueryClient (request-scoped on the server, singleton in the browser via
 * `getQueryClient`) so server-prefetched cases hydrate into the same cache the client
 * reads. Mirrors the console's Providers, minus analytics/devtools.
 */
export function QueryProvider({ children }: { children: React.ReactNode }) {
	const queryClient = getQueryClient();
	return (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
}
