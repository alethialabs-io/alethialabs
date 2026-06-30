// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type React from "react";
import { pageMetadata } from "@/lib/seo/page-metadata";

// The agent page is a client component (it streams a conversation), so its metadata lives
// on this thin server layout instead of the page file.
export const metadata = pageMetadata({
	title: "Agent",
	description: "Design and provision infrastructure through a conversation.",
});

export default function AgentLayout({ children }: { children: React.ReactNode }) {
	return children;
}
