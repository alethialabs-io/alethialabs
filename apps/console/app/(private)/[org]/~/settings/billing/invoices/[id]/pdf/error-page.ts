// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The invoice PDF route's failure answer (CON-L3, R6 F-08). The route is read in two places that
// both RENDER whatever comes back: the preview dialog's iframe, and the browser tab a "Download PDF"
// click navigates. It used to answer every failure with JSON, so a person saw
// `{"error":"Forbidden"}` printed in the preview. It now answers a small, self-contained HTML page
// with one sentence, and the status code is unchanged, so anything that reads the status still
// gets the same answer it always did.
//
// Self-contained on purpose: the page renders inside an iframe with none of the console's CSS, so
// it carries its own minimal style and uses the system font, in both colour schemes. Every string
// it prints is one of the fixed sentences below; nothing from the request or the database reaches
// the markup.

/** Why the route could not serve a PDF. */
export type InvoicePdfFailure =
	| "signed-out"
	| "forbidden"
	| "not-found"
	| "no-pdf"
	| "unavailable";

/** The status and the sentence for each failure. */
const FAILURES: Record<InvoicePdfFailure, { status: number; title: string; body: string }> = {
	"signed-out": {
		status: 401,
		title: "Your session has ended",
		body: "Sign in again, then reopen this invoice.",
	},
	forbidden: {
		status: 403,
		title: "Billing admins only",
		body: "You need the billing permission in this organization to see its invoices.",
	},
	"not-found": {
		status: 404,
		title: "Invoice not found",
		body: "This invoice doesn't exist, or it isn't in this organization.",
	},
	"no-pdf": {
		status: 404,
		title: "No PDF for this invoice",
		body: "There's no document stored for this invoice. Contact support if you need a copy.",
	},
	unavailable: {
		status: 503,
		title: "Couldn't load this invoice",
		body: "Something went wrong reading the PDF. Try again in a moment.",
	},
};

/** The HTML page a failure renders as. Exported for the route's tests. */
export function invoicePdfErrorHtml(failure: InvoicePdfFailure): string {
	const { title, body } = FAILURES[failure];
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title}</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,sans-serif;background:Canvas;color:CanvasText}
main{max-width:28rem;padding:1.5rem;text-align:center}
.t{margin:0 0 .5rem;font-size:1rem;font-weight:600}
.b{margin:0;font-size:.875rem;line-height:1.5}
</style>
</head>
<body>
<main data-invoice-pdf-error="${failure}">
<p class="t">${title}</p>
<p class="b">${body}</p>
</main>
</body>
</html>`;
}

/** The route's failure response: the HTML page, under the failure's status code. */
export function invoicePdfError(failure: InvoicePdfFailure): Response {
	return new Response(invoicePdfErrorHtml(failure), {
		status: FAILURES[failure].status,
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "private, no-store",
		},
	});
}
