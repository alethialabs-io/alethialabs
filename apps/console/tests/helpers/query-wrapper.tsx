// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

/**
 * A Testing Library `wrapper` that provides a FRESH QueryClient (retries off, so a failed read
 * surfaces at once) — for components that read the query cache somewhere below them.
 */
export function queryWrapper(): (props: { children: ReactNode }) => ReactNode {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return function QueryWrapper({ children }: { children: ReactNode }) {
		return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
	};
}
