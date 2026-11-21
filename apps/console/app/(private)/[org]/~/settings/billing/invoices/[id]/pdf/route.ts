// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Authorized invoice-PDF download/preview. Serves the self-hosted PDF captured at payment
// time from object storage (Content-Disposition inline so the preview dialog can iframe
// it; `?download=1` forces an attachment). Owner-gated via manage_billing on the ACTIVE
// org (the [org] slug is routing only) and scoped so one org can't fetch another's PDF;
// falls back to Stripe's hosted invoice URL if we never captured a local copy, or if the
// stored copy cannot be read.
//
// Every failure answers an HTML page (`./error-page.ts`), never JSON: both readers of this route —
// the preview iframe and a "Download PDF" navigation — render the body as it is (CON-L3, R6 F-08).

import { NextResponse } from "next/server";
import { authorize } from "@/lib/authz/guard";
import { ForbiddenError } from "@/lib/authz/types";
import { errorDigest } from "@/lib/errors";
import { getOrgInvoice } from "@/lib/billing/invoices";
import { storage } from "@/lib/storage";
import { INVOICE_PDF_BUCKET } from "@/lib/storage/invoice-pdf";
import { invoicePdfError } from "./error-page";

/** Serves one invoice's PDF to a billing admin of the active org, or an HTML page saying why not. */
export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
): Promise<Response> {
	const { id } = await params;

	let orgId: string;
	try {
		const actor = await authorize("manage_billing", { type: "billing" });
		orgId = actor.orgId;
	} catch (err) {
		if (err instanceof ForbiddenError) {
			return invoicePdfError("forbidden");
		}
		// A non-member of the org this address names: `urlScopedOrgId` signals `notFound()`. Answer
		// it as the unknown org it is indistinguishable from — not 401, which wrongly says "sign in"
		// and confirms nothing (#6113, ADR 0005 stress test R4).
		if ((errorDigest(err) ?? "").startsWith("NEXT_HTTP_ERROR_FALLBACK;404")) {
			return invoicePdfError("not-found");
		}
		return invoicePdfError("signed-out");
	}

	let row: Awaited<ReturnType<typeof getOrgInvoice>>;
	try {
		row = await getOrgInvoice(orgId, id);
	} catch {
		return invoicePdfError("unavailable");
	}
	if (!row) {
		return invoicePdfError("not-found");
	}

	// Prefer the self-hosted PDF; fall back to Stripe's hosted document link. A storage read that
	// THROWS is treated like a missing object while Stripe still has a copy: it is the same invoice,
	// and a person asking for it should get it rather than an error.
	let storageFailed = false;
	if (row.pdfKey) {
		let bytes: Uint8Array | null = null;
		try {
			bytes = await storage.get(INVOICE_PDF_BUCKET, row.pdfKey);
		} catch {
			storageFailed = true;
		}
		if (bytes) {
			const download = new URL(req.url).searchParams.get("download") === "1";
			const filename = `Invoice-${row.number ?? id}.pdf`;
			// Copy into a fresh (ArrayBuffer-backed) view so the bytes satisfy BlobPart —
			// storage returns `Uint8Array<ArrayBufferLike>`, which TS won't narrow to the
			// ArrayBuffer-backed view Blob requires.
			return new Response(new Blob([new Uint8Array(bytes)], { type: "application/pdf" }), {
				status: 200,
				headers: {
					"Content-Type": "application/pdf",
					"Content-Disposition": `${download ? "attachment" : "inline"}; filename="${filename}"`,
					"Cache-Control": "private, max-age=0, must-revalidate",
				},
			});
		}
	}
	if (row.hostedInvoiceUrl) {
		return NextResponse.redirect(row.hostedInvoiceUrl);
	}
	return invoicePdfError(storageFailed ? "unavailable" : "no-pdf");
}
