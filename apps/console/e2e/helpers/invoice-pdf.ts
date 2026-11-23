// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Seeds a stored фактура PDF the way production stores one, so an e2e invoice row has a document
// the authorized PDF route can serve.
//
// Production: `requestFactura` (lib/billing/factura/issue.ts) puts the фактура's bytes into the
// object store at `INVOICE_PDF_BUCKET` / `invoicePdfKey(orgId, stripeInvoiceId)`, and
// `mirrorPaidInvoice` (lib/billing/invoices.ts) writes that key into `invoice.pdf_key`. The route
// (app/(private)/[org]/~/settings/billing/invoices/[id]/pdf) reads `pdf_key` and serves exactly
// those bytes. Since EA-7b (#7338) a row WITHOUT `pdf_key` answers the
// "Your invoice is being issued" page (404) and never redirects to Stripe's hosted invoice, so a
// seed that carries only `hosted_invoice_url` is, correctly, an invoice with no document.
//
// This helper writes the object half, with the SAME bucket and key policy (imported, not
// re-typed), against the SAME store the console under test reads: the `ALETHIA_STORAGE_*`
// variables the gate's job env hands both processes. The caller writes the key into `pdf_key`
// in its own insert. An unset variable throws rather than skipping — a test that silently seeded
// no PDF would be measuring the "being issued" branch while claiming to measure the served one.

import {
	CreateBucketCommand,
	HeadBucketCommand,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { INVOICE_PDF_BUCKET, invoicePdfKey } from "@/lib/storage/invoice-pdf";
import { loadRootEnv } from "./env";

let client: S3Client | null = null;
let bucketReady = false;

/** The S3 client for the console's object store, built from the same env the console reads. */
function s3(): S3Client {
	if (client) return client;
	loadRootEnv();
	const endpoint = process.env.ALETHIA_STORAGE_ENDPOINT;
	const accessKeyId = process.env.ALETHIA_STORAGE_ACCESS_KEY_ID;
	const secretAccessKey = process.env.ALETHIA_STORAGE_SECRET_ACCESS_KEY;
	if (!endpoint || !accessKeyId || !secretAccessKey) {
		throw new Error(
			"ALETHIA_STORAGE_ENDPOINT / _ACCESS_KEY_ID / _SECRET_ACCESS_KEY are not all set, so no invoice " +
				"PDF can be stored for the console under test to serve.",
		);
	}
	client = new S3Client({
		endpoint,
		region: process.env.ALETHIA_STORAGE_REGION || "us-east-1",
		credentials: { accessKeyId, secretAccessKey },
		forcePathStyle: true,
	});
	return client;
}

/** Creates the invoices bucket if it is absent (the console only creates it on its first write). */
async function ensureInvoiceBucket(): Promise<void> {
	if (bucketReady) return;
	try {
		await s3().send(new HeadBucketCommand({ Bucket: INVOICE_PDF_BUCKET }));
	} catch {
		try {
			await s3().send(new CreateBucketCommand({ Bucket: INVOICE_PDF_BUCKET }));
		} catch (err) {
			const name = err instanceof Error ? err.name : "";
			if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") throw err;
		}
	}
	bucketReady = true;
}

/** A minimal, well-formed one-page PDF whose text names the invoice number, so each seed's bytes are its own. */
function facturaPdfBytes(number: string): Uint8Array {
	const text = `(Factura ${number.replace(/[()\\]/g, "")})`;
	const stream = `BT /F1 12 Tf 72 720 Td ${text} Tj ET`;
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	let out = "%PDF-1.4\n";
	const offsets: number[] = [];
	objects.forEach((body, i) => {
		offsets.push(out.length);
		out += `${i + 1} 0 obj\n${body}\nendobj\n`;
	});
	const xref = out.length;
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
	out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return new TextEncoder().encode(out);
}

/**
 * Stores a фактура PDF for `stripeInvoiceId` in `orgId` at the production key and returns that key
 * (for the caller's `pdf_key`) with the exact bytes stored, so a test can assert the route served
 * THIS document and not merely some PDF.
 */
export async function storeFacturaPdf(
	orgId: string,
	stripeInvoiceId: string,
	number: string,
): Promise<{ pdfKey: string; bytes: Uint8Array }> {
	await ensureInvoiceBucket();
	const pdfKey = invoicePdfKey(orgId, stripeInvoiceId);
	const bytes = facturaPdfBytes(number);
	await s3().send(
		new PutObjectCommand({
			Bucket: INVOICE_PDF_BUCKET,
			Key: pdfKey,
			Body: bytes,
			ContentType: "application/pdf",
		}),
	);
	return { pdfKey, bytes };
}
