"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useParams } from "next/navigation";
import { SpecDetailView } from "@/components/spec-detail/spec-detail-view";

/** Legacy UUID spec route — renders the shared view. C2's slug route
 * (`/{org}/{zone}/{spec}[/{env}]`) renders the same view by resolved ids. */
export default function SpecDetailPage() {
	const { id: zoneId, specId } = useParams<{ id: string; specId: string }>();
	return <SpecDetailView zoneId={zoneId} specId={specId} />;
}
