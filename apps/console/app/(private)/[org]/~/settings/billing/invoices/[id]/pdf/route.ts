// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Authorized invoice-PDF download/preview. Serves the self-hosted PDF captured at payment
// time from object storage (Content-Disposition inline so the preview dialog can iframe
// it; `?download=1` forces an attachment). Owner-gated via manage_billing on the ACTIVE
// org (the [org] slug is routing only) and scoped so one org can't fetch another's PDF;
// falls back to Stripe's hosted invoice URL if we never captured a local copy.

import { NextResponse } from "next/server";
import { authorize } from "@/lib/authz/guard";
import { ForbiddenError } from "@/lib/authz/types";
import { getOrgInvoice } from "@/lib/billing/invoices";
import { storage } from "@/lib/storage";
import { INVOICE_PDF_BUCKET } from "@/lib/storage/invoice-pdf";

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
			return NextResponse.json({ error: "Forbidden" }, { status: 403 });
		}
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const row = await getOrgInvoice(orgId, id);
	if (!row) {
		return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
	}

	// Prefer the self-hosted PDF; fall back to Stripe's hosted document link.
	if (row.pdfKey) {
		const bytes = await storage.get(INVOICE_PDF_BUCKET, row.pdfKey);
		if (bytes) {
			const download = new URL(req.url).searchParams.get("download") === "1";
			const filename = `Invoice-${row.number ?? id}.pdf`;
			return new Response(bytes as unknown as BodyInit, {
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
	return NextResponse.json({ error: "No PDF available" }, { status: 404 });
}
