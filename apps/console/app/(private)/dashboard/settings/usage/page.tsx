// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getAiUsage } from "@/app/server/actions/ai-billing";
import { UsagePanel } from "@/components/billing/usage-panel";
import { AI_CREDIT_PACKS } from "@/lib/billing/ai-credits";

// PLACEHOLDER page — to be replaced by the claude.ai `console/usage.html` design.
export default async function UsagePage() {
	const usage = await getAiUsage();
	return <UsagePanel usage={usage} packs={AI_CREDIT_PACKS} />;
}
