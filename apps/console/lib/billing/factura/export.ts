// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The accountant's monthly export of the фактури and credit notes (#7369), as pure functions over
// rows the operator script (scripts/factura-export.ts) reads. Everything here is deterministic: the
// same rows give the same bytes, so a re-run of a closed month reproduces the files and their
// SHA-256 values.
//
// THE FILES, for month M:
//  - `facturi-M.csv`: one line per document issued in M (Sofia dates), фактури and credit notes,
//    in number order: number, kind, the corrected фактура, dates, recipient, amounts in the document
//    currency and in EUR with the rate, its date and source, the no-VAT ground, the Stripe ids, and
//    the PDF's file name and SHA-256;
//  - `facturi-M-pdfs.zip`: every PDF under `pdfs/<number>.pdf`, stored (PDFs are already compressed);
//  - `stripe-balance-M.csv`: every Stripe balance transaction created in M (gross, fee, net, type,
//    the payout it settled in), so the accountant can reconcile payouts and fees to the documents;
//  - `MANIFEST.sha256`: the SHA-256 of each file above and of each PDF, in `sha256sum` format, so
//    `shasum -a 256 -c MANIFEST.sha256` verifies the set once the ZIP is unpacked beside it.
// The CSVs are UTF-8 with a byte-order mark (spreadsheet programs read Cyrillic correctly with it)
// and CRLF line ends (RFC 4180). Amounts are decimal strings in major units, never floats.

import { createHash } from "node:crypto";
import { stripeChargeDivisor } from "@repo/format";
import type { Factura } from "@/lib/db/schema";

/** A file of the export: its name inside the output directory and its bytes. */
export interface ExportFile {
	name: string;
	data: Uint8Array;
}

/** The calendar window of a month, in Sofia (where the supplier keeps its books). */
export interface MonthWindow {
	/** YYYY-MM. */
	month: string;
	/** YYYY-MM-DD, the first day. */
	firstDay: string;
	/** YYYY-MM-DD, the last day. */
	lastDay: string;
	/** Epoch seconds of the first day's Sofia midnight (inclusive). */
	startEpoch: number;
	/** Epoch seconds of the next month's Sofia midnight (exclusive). */
	endEpoch: number;
}

/** One Stripe balance transaction, as the reconciliation CSV prints it. */
export interface BalanceRow {
	id: string;
	/** Epoch seconds. */
	created: number;
	/** Epoch seconds. */
	availableOn: number;
	type: string;
	reportingCategory: string;
	description: string | null;
	/** ISO 4217, lower-case (Stripe's convention). */
	currency: string;
	/** Minor units. */
	amount: number;
	fee: number;
	net: number;
	/** The charge, refund, payout … the transaction belongs to. */
	source: string | null;
	/** The payout the transaction was paid out in, when known. */
	payoutId: string | null;
}

/** The YYYY-MM-DD of `d` in Sofia. */
function sofiaDate(d: Date): string {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: "Europe/Sofia",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(d);
}

/** Epoch milliseconds of Sofia midnight starting `day` (YYYY-MM-DD): UTC+2 in winter, UTC+3 in summer. */
function sofiaMidnight(day: string): number {
	const [y, m, d] = day.split("-").map(Number);
	const utc = Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1);
	for (const hours of [2, 3]) {
		const at = utc - hours * 3_600_000;
		if (sofiaDate(new Date(at)) === day && sofiaDate(new Date(at - 1)) !== day) return at;
	}
	throw new Error(`no Sofia midnight found for ${day}`);
}

/** The window of month `month` (YYYY-MM); throws on anything else. */
export function monthWindow(month: string): MonthWindow {
	const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
	if (!match) throw new Error(`--month must be YYYY-MM, got "${month}"`);
	const y = Number(match[1]);
	const m = Number(match[2]);
	const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
	const lastDate = new Date(Date.UTC(y, m, 0));
	const firstDay = `${month}-01`;
	return {
		month,
		firstDay,
		lastDay: lastDate.toISOString().slice(0, 10),
		startEpoch: sofiaMidnight(firstDay) / 1000,
		endEpoch: sofiaMidnight(`${next}-01`) / 1000,
	};
}

/** An amount in `currency`'s minor unit as a decimal string in major units: 5500 USD → "55.00". */
export function minorToDecimal(minor: number, currency: string): string {
	if (stripeChargeDivisor(currency) === 1) return String(minor);
	const sign = minor < 0 ? "-" : "";
	const abs = Math.abs(minor);
	return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** One CSV field, quoted when it holds a comma, a quote or a line break (RFC 4180). */
function field(value: string | number | null | undefined): string {
	const s = value === null || value === undefined ? "" : String(value);
	return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** A CSV document: a byte-order mark, the header, the rows, CRLF line ends. */
function csv(header: readonly string[], rows: (string | number | null)[][]): Uint8Array {
	const lines = [header, ...rows].map((r) => r.map(field).join(","));
	return new TextEncoder().encode(`﻿${lines.join("\r\n")}\r\n`);
}

/** The file name of a document's PDF inside the ZIP. */
export function pdfEntryName(row: Pick<Factura, "number">): string {
	return `pdfs/${row.number}.pdf`;
}

/** The columns of the documents CSV, in order. */
export const FACTURA_CSV_HEADER = [
	"number",
	"kind",
	"original_number",
	"original_issue_date",
	"issue_date",
	"chargeable_date",
	"recipient_name",
	"recipient_id",
	"recipient_country",
	"currency",
	"tax_base",
	"vat",
	"total",
	"tax_base_eur",
	"vat_eur",
	"eur_rate",
	"eur_rate_date",
	"eur_rate_source",
	"no_vat_ground",
	"reason",
	"stripe_invoice_id",
	"stripe_refund_id",
	"stripe_invoice_number",
	"pdf_file",
	"pdf_sha256",
] as const;

/**
 * The documents CSV, in number order. An EUR document's EUR columns repeat its amounts at rate 1
 * (source `EUR`), so every line carries an EUR figure the accountant can sum.
 */
export function facturaCsv(rows: readonly Factura[]): Uint8Array {
	const sorted = [...rows].sort((a, b) => a.number.localeCompare(b.number));
	return csv(
		FACTURA_CSV_HEADER,
		sorted.map((r) => {
			const s = r.snapshot;
			const eur = s.eurEquivalent;
			return [
				r.number,
				r.kind,
				s.original?.number ?? null,
				s.original?.issueDate ?? null,
				r.issueDate,
				r.chargeableDate,
				s.recipient.name,
				s.recipient.identifiers.map((i) => i.value).join("; "),
				s.recipient.country,
				s.currency,
				minorToDecimal(s.taxBaseMinor, s.currency),
				minorToDecimal(s.vatMinor, s.currency),
				minorToDecimal(s.totalMinor, s.currency),
				minorToDecimal(eur ? eur.taxBaseEurMinor : s.taxBaseMinor, "EUR"),
				minorToDecimal(eur ? eur.vatEurMinor : s.vatMinor, "EUR"),
				eur ? eur.rate : "1.00000000",
				eur ? eur.rateDate : r.chargeableDate,
				eur ? eur.source : "EUR",
				s.noVatGround,
				s.reason ?? null,
				r.stripeInvoiceId,
				r.stripeRefundId,
				s.stripeInvoiceNumber,
				pdfEntryName(r),
				r.pdfSha256,
			];
		}),
	);
}

/** The columns of the Stripe balance CSV, in order. */
export const BALANCE_CSV_HEADER = [
	"id",
	"created_utc",
	"available_on_utc",
	"type",
	"reporting_category",
	"description",
	"currency",
	"gross",
	"fee",
	"net",
	"source",
	"payout_id",
] as const;

/** epoch seconds → ISO 8601 UTC. */
function isoUtc(epochSeconds: number): string {
	return new Date(epochSeconds * 1000).toISOString();
}

/** The Stripe balance CSV, oldest first (ties by id). */
export function balanceCsv(rows: readonly BalanceRow[]): Uint8Array {
	const sorted = [...rows].sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
	return csv(
		BALANCE_CSV_HEADER,
		sorted.map((r) => [
			r.id,
			isoUtc(r.created),
			isoUtc(r.availableOn),
			r.type,
			r.reportingCategory,
			r.description,
			r.currency.toUpperCase(),
			minorToDecimal(r.amount, r.currency),
			minorToDecimal(r.fee, r.currency),
			minorToDecimal(r.net, r.currency),
			r.source,
			r.payoutId,
		]),
	);
}

/** Lower-case hex SHA-256. */
export function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** The `sha256sum` manifest of `files`, sorted by name. */
export function manifest(files: readonly ExportFile[]): Uint8Array {
	const lines = [...files]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((f) => `${sha256Hex(f.data)}  ${f.name}`);
	return new TextEncoder().encode(`${lines.join("\n")}\n`);
}

// ── A stored (uncompressed) ZIP ─────────────────────────────────────────────────────────────────
// The console has no ZIP dependency and needs none: PDFs are already deflated, so the STORE method
// (no compression) loses nothing. Fixed timestamps (1980-01-01) keep the archive reproducible.

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

/** The CRC-32 (IEEE) of `data`, as ZIP records it. */
export function crc32(data: Uint8Array): number {
	let c = 0xffffffff;
	for (const byte of data) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/** DOS date for 1980-01-01, the earliest a ZIP can say. */
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

/**
 * A ZIP archive of `files`, stored, with UTF-8 names (flag bit 11). Refuses more than 65535 entries
 * or 4 GiB, which a month of фактури never reaches (no ZIP64).
 */
export function zipStore(files: readonly ExportFile[]): Uint8Array {
	if (files.length > 0xffff) throw new Error("too many files for a ZIP without ZIP64");
	const enc = new TextEncoder();
	const locals: Uint8Array[] = [];
	const centrals: Uint8Array[] = [];
	let offset = 0;
	for (const f of files) {
		const name = enc.encode(f.name);
		const crc = crc32(f.data);
		const local = new Uint8Array(30 + name.length);
		const lv = new DataView(local.buffer);
		lv.setUint32(0, 0x04034b50, true);
		lv.setUint16(4, 20, true); // version needed
		lv.setUint16(6, 0x0800, true); // UTF-8 names
		lv.setUint16(8, 0, true); // stored
		lv.setUint16(10, 0, true); // time
		lv.setUint16(12, DOS_DATE, true);
		lv.setUint32(14, crc, true);
		lv.setUint32(18, f.data.length, true);
		lv.setUint32(22, f.data.length, true);
		lv.setUint16(26, name.length, true);
		lv.setUint16(28, 0, true);
		local.set(name, 30);

		const central = new Uint8Array(46 + name.length);
		const cv = new DataView(central.buffer);
		cv.setUint32(0, 0x02014b50, true);
		cv.setUint16(4, 20, true); // version made by
		cv.setUint16(6, 20, true); // version needed
		cv.setUint16(8, 0x0800, true);
		cv.setUint16(10, 0, true);
		cv.setUint16(12, 0, true);
		cv.setUint16(14, DOS_DATE, true);
		cv.setUint32(16, crc, true);
		cv.setUint32(20, f.data.length, true);
		cv.setUint32(24, f.data.length, true);
		cv.setUint16(28, name.length, true);
		cv.setUint32(42, offset, true);
		central.set(name, 46);

		locals.push(local, f.data);
		centrals.push(central);
		offset += local.length + f.data.length;
		if (offset > 0xffffffff) throw new Error("archive too large for a ZIP without ZIP64");
	}
	const centralSize = centrals.reduce((n, c) => n + c.length, 0);
	const end = new Uint8Array(22);
	const ev = new DataView(end.buffer);
	ev.setUint32(0, 0x06054b50, true);
	ev.setUint16(8, files.length, true);
	ev.setUint16(10, files.length, true);
	ev.setUint32(12, centralSize, true);
	ev.setUint32(16, offset, true);
	const parts = [...locals, ...centrals, end];
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

/** A document whose PDF cannot go into the export as it stands. */
export interface ExportProblem {
	number: string;
	problem: string;
}

/**
 * The export of month `window` from its documents, their PDFs (by number; null when storage has
 * none) and the Stripe balance transactions. Refuses — returns the problems and no files — when a
 * document has no PDF yet or its PDF does not match the SHA-256 recorded at issue: an accountant's
 * set must be complete and intact, and the sweeper renders a missing PDF within the hour.
 */
export function buildExport(
	window: MonthWindow,
	documents: readonly Factura[],
	pdfs: ReadonlyMap<string, Uint8Array | null>,
	balance: readonly BalanceRow[],
): { ok: true; files: ExportFile[] } | { ok: false; problems: ExportProblem[] } {
	const problems: ExportProblem[] = [];
	const pdfFiles: ExportFile[] = [];
	for (const doc of [...documents].sort((a, b) => a.number.localeCompare(b.number))) {
		const pdf = pdfs.get(doc.number) ?? null;
		if (!doc.pdfSha256) problems.push({ number: doc.number, problem: "no PDF attached yet" });
		else if (!pdf) problems.push({ number: doc.number, problem: "PDF missing from storage" });
		else if (sha256Hex(pdf) !== doc.pdfSha256) {
			problems.push({ number: doc.number, problem: "stored PDF does not match its recorded SHA-256" });
		} else pdfFiles.push({ name: pdfEntryName(doc), data: pdf });
	}
	if (problems.length) return { ok: false, problems };
	const m = window.month;
	const files: ExportFile[] = [
		{ name: `facturi-${m}.csv`, data: facturaCsv(documents) },
		{ name: `facturi-${m}-pdfs.zip`, data: zipStore(pdfFiles) },
		{ name: `stripe-balance-${m}.csv`, data: balanceCsv(balance) },
	];
	return { ok: true, files: [...files, { name: "MANIFEST.sha256", data: manifest([...files, ...pdfFiles]) }] };
}
