// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ApprovalsSkeleton } from "@/components/approvals/approvals-skeleton";

/** Skeleton for the approvals route, in the shape of the list it is about to be. */
export default function ApprovalsLoading() {
	return <ApprovalsSkeleton />;
}
