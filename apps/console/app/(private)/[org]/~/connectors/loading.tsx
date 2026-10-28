// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ConnectorsSkeleton } from "@/components/connectors/connectors-skeleton";

/** The connectors route while its board read is prefetched: the board's own layout, no title. */
export default function ConnectorsLoading() {
	return <ConnectorsSkeleton />;
}
