// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { saveAsFile } from "@/components/clusters/kubeconfig-download/flow";
import type { SignedReceipt } from "@/types/jsonb.types";

/** The file name a receipt is saved under: the job's short id, so two receipts never collide. */
function receiptFileName(jobId: string): string {
	return `elench-receipt-${jobId.slice(0, 8)}.json`;
}

/**
 * Saves a signed evidence receipt as pretty-printed JSON. The file can be verified offline against
 * the signing public key (mirrors the artifact panel's ReceiptBlock).
 *
 * Goes through the console's one `saveAsFile`, which attaches the link to the document and revokes
 * its URL on the next task — revoking it synchronously after the click is read by some browsers as
 * cancelling the download. Returns the file name for the confirmation; throws when the browser
 * refused to create the file, so the caller never confirms a download that did not start.
 */
export function downloadReceipt(receipt: SignedReceipt, jobId: string): string {
	const fileName = receiptFileName(jobId);
	saveAsFile(fileName, JSON.stringify(receipt, null, 2));
	return fileName;
}
