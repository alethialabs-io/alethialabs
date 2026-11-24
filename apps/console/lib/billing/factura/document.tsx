// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Renders a фактура to PDF with @react-pdf/renderer (#7368): pure Node, no browser in production.
// It prints the strings of `facturaLayout` and nothing else, so the layout's golden test covers the
// document's text.
//
// REPRODUCIBLE. The PDF's creation and modification dates are the issue date, and the producer
// strings are fixed, so the same snapshot renders to the same bytes. That is what lets the SHA-256
// stored beside the row prove the stored PDF unchanged (Art. 121(1) ЗДДС, integrity), and lets a
// lost PDF be re-rendered from the snapshot.
//
// FONTS. Noto Sans Regular and Bold, TTF, because the document is Cyrillic and @react-pdf reads
// neither woff2 nor the Latin-only brand subsets. They are vendored unmodified next to this file
// (fonts/, SIL Open Font License 1.1, text in fonts/OFL.txt) from the Noto project
// (github.com/notofonts/notofonts.github.io, fonts/NotoSans/hinted/ttf/), SHA-256:
//   478c558ea716033cd60c03438f628dfa75694dcf6b5f6d505a2f05fd2b4f3823  NotoSans-Regular.ttf
//   1df075a380fc7cb898acf64c1f7b3b4dd780de3caa860178bf929de35817a913  NotoSans-Bold.ttf
// They are read from the working directory, which is apps/console under vitest and in the
// standalone server (server.js changes into its own directory); next.config.ts traces them into
// the standalone output.
// Server-only.

import { join } from "node:path";
import { Document, Font, Page, renderToBuffer, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { FacturaSnapshot } from "@/types/jsonb.types";
import { type FacturaLayout, facturaLayout, type LayoutPair } from "./layout";

/** Where the vendored fonts live, relative to the console's root. */
const FACTURA_FONT_DIR = "lib/billing/factura/fonts";

/** The registered font family; the чл. 117 protocols (lib/billing/nra/) print with it too. */
export const FACTURA_FONT_FAMILY = "NotoSans";
const FAMILY = FACTURA_FONT_FAMILY;

let fontsRegistered = false;

/** Registers the Cyrillic-capable font once per process, and turns hyphenation off. */
export function registerFonts(): void {
	if (fontsRegistered) return;
	const dir = join(process.cwd(), FACTURA_FONT_DIR);
	Font.register({
		family: FAMILY,
		fonts: [
			{ src: join(dir, "NotoSans-Regular.ttf"), fontWeight: 400 },
			{ src: join(dir, "NotoSans-Bold.ttf"), fontWeight: 700 },
		],
	});
	// A legal document is never hyphenated: a name or a number split across lines misreads.
	Font.registerHyphenationCallback((word) => [word]);
	fontsRegistered = true;
}

const styles = StyleSheet.create({
	page: { fontFamily: FAMILY, fontSize: 9, padding: 40, lineHeight: 1.35 },
	title: { fontSize: 16, fontWeight: 700 },
	number: { fontSize: 12, fontWeight: 700, marginBottom: 8 },
	row: { flexDirection: "row" },
	parties: { flexDirection: "row", marginTop: 12, marginBottom: 12 },
	party: { flex: 1, paddingRight: 12 },
	heading: { fontWeight: 700, marginBottom: 2 },
	tableHeader: { flexDirection: "row", borderBottomWidth: 1, fontWeight: 700, paddingBottom: 2 },
	tableRow: { flexDirection: "row", borderBottomWidth: 0.5, paddingVertical: 3 },
	cellNo: { width: "6%" },
	cellService: { width: "44%", paddingRight: 6 },
	cellQty: { width: "10%", textAlign: "right" },
	cellMoney: { width: "20%", textAlign: "right" },
	totals: { marginTop: 8, alignItems: "flex-end" },
	pair: { flexDirection: "row", justifyContent: "flex-end" },
	pairLabel: { paddingRight: 8 },
	pairValue: { width: 90, textAlign: "right", fontWeight: 700 },
	notes: { marginTop: 14 },
});

/** A right-aligned label and value. */
function Pair({ p }: { p: LayoutPair }) {
	return (
		<View style={styles.pair}>
			<Text style={styles.pairLabel}>{p.label}</Text>
			<Text style={styles.pairValue}>{p.value}</Text>
		</View>
	);
}

const CELLS = [styles.cellNo, styles.cellService, styles.cellQty, styles.cellMoney, styles.cellMoney];

/** The фактура page for a computed layout. */
function FacturaPage({ l }: { l: FacturaLayout }) {
	return (
		<Page size="A4" style={styles.page}>
			<Text style={styles.title}>{l.title}</Text>
			<Text style={styles.number}>{l.number}</Text>
			{l.dates.map((d) => (
				<View key={d.label} style={styles.row}>
					<Text>{`${d.label}: ${d.value}`}</Text>
				</View>
			))}
			<View style={styles.parties}>
				{[l.supplier, l.recipient].map((p) => (
					<View key={p.heading} style={styles.party}>
						<Text style={styles.heading}>{p.heading}</Text>
						{p.lines.map((line, i) => (
							<Text key={`${i}:${line}`}>{line}</Text>
						))}
					</View>
				))}
			</View>
			<View style={styles.tableHeader}>
				{l.table.header.map((h, i) => (
					<Text key={h} style={CELLS[i]}>
						{h}
					</Text>
				))}
			</View>
			{l.table.rows.map((r) => (
				<View key={r[0]} style={styles.tableRow} wrap={false}>
					{r.map((c, i) => (
						<Text key={`${l.table.header[i]}:${c}`} style={CELLS[i]}>
							{c}
						</Text>
					))}
				</View>
			))}
			<View style={styles.totals}>
				{l.totals.map((p) => (
					<Pair key={p.label} p={p} />
				))}
				{l.eur?.totals.map((p) => (
					<Pair key={p.label} p={p} />
				))}
				{l.eur ? <Text>{l.eur.rate}</Text> : null}
			</View>
			<View style={styles.notes}>
				{l.notes.map((n) => (
					<Text key={n}>{n}</Text>
				))}
			</View>
		</Page>
	);
}

/** Renders the фактура `s` to PDF bytes. The same snapshot always renders the same bytes. */
export async function renderFacturaPdf(s: FacturaSnapshot): Promise<Uint8Array> {
	registerFonts();
	const at = new Date(`${s.issueDate}T00:00:00Z`);
	const buf = await renderToBuffer(
		<Document
			title={`${s.documentName} ${s.number}`}
			author="Alethia Labs"
			creator="Alethia"
			producer="Alethia"
			creationDate={at}
			modificationDate={at}
			language="bg"
		>
			<FacturaPage l={facturaLayout(s)} />
		</Document>,
	);
	return new Uint8Array(buf);
}
