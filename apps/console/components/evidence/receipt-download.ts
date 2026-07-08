// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { SignedReceipt } from "@/types/jsonb.types";

/**
 * Downloads a signed evidence receipt as pretty-printed JSON. The file can be verified
 * offline against the signing public key (mirrors the artifact panel's ReceiptBlock).
 * Returns a short confirmation string for the download toast.
 */
export function downloadReceipt(receipt: SignedReceipt, jobId: string): string {
	const blob = new Blob([JSON.stringify(receipt, null, 2)], {
		type: "application/json",
	});
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = `elench-receipt-${jobId.slice(0, 8)}.json`;
	a.click();
	URL.revokeObjectURL(url);
	return "Receipt downloaded";
}
