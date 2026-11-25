// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { TokensSkeleton } from "@/components/settings/tokens/tokens-skeleton";

/** Instant skeleton for the settings/tokens route: the page's toolbar, filter bar and table. */
export default function ServiceTokensLoading() {
	return <TokensSkeleton />;
}
