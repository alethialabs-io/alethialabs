// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Renders a чл. 117 protocol to PDF with the фактура's renderer and fonts: the ProtocolRenderer the
// console injects into @repo/nra (which has no PDF library). It prints the strings of
// `protocolLayout` and nothing else. The PDF dates are the issue date and the producer strings are
// fixed, so within one process the same protocol renders the same bytes. Across processes the
// embedded font subset can differ with what the process rendered before (factura:export renders the
// фактури first; nra:build does not), so the reproducible artefact is the text (protocolText, the
// .txt copy), and two PDFs of one protocol are compared by their text, not their bytes.
// Server-only.

import { Document, Page, renderToBuffer, StyleSheet, Text, View } from "@react-pdf/renderer";
import { FACTURA_FONT_FAMILY, registerFonts } from "@/lib/billing/factura/document";
import { type ProtocolLayout, type ProtocolPair, protocolLayout, type ReverseChargeProtocol } from "@repo/nra";

const styles = StyleSheet.create({
	page: { fontFamily: FACTURA_FONT_FAMILY, fontSize: 9, padding: 40, lineHeight: 1.35 },
	title: { fontSize: 16, fontWeight: 700, lineHeight: 1.2, marginBottom: 6 },
	subtitle: { marginBottom: 4 },
	number: { fontSize: 12, fontWeight: 700, marginBottom: 8 },
	parties: { flexDirection: "row", marginTop: 12, marginBottom: 12 },
	party: { flex: 1, paddingRight: 12 },
	heading: { fontWeight: 700, marginBottom: 2 },
	tableHeader: { flexDirection: "row", borderBottomWidth: 1, fontWeight: 700, paddingBottom: 2 },
	tableRow: { flexDirection: "row", borderBottomWidth: 0.5, paddingVertical: 3 },
	cellNo: { width: "8%" },
	cellService: { width: "52%", paddingRight: 6 },
	cellMoney: { width: "40%", textAlign: "right" },
	totals: { marginTop: 8, alignItems: "flex-end" },
	pair: { flexDirection: "row", justifyContent: "flex-end" },
	pairLabel: { paddingRight: 8 },
	pairValue: { width: 90, textAlign: "right", fontWeight: 700 },
	notes: { marginTop: 14 },
});

const CELLS = [styles.cellNo, styles.cellService, styles.cellMoney];

/** A right-aligned label and value. */
function Pair({ p }: { p: ProtocolPair }) {
	return (
		<View style={styles.pair}>
			<Text style={styles.pairLabel}>{p.label}</Text>
			<Text style={styles.pairValue}>{p.value}</Text>
		</View>
	);
}

/** The protocol page for a computed layout. */
function ProtocolPage({ l }: { l: ProtocolLayout }) {
	return (
		<Page size="A4" style={styles.page}>
			<Text style={styles.title}>{l.title}</Text>
			<Text style={styles.subtitle}>{l.subtitle}</Text>
			<Text style={styles.number}>{l.number}</Text>
			{l.dates.map((d) => (
				<Text key={d.label}>{`${d.label}: ${d.value}`}</Text>
			))}
			<View style={styles.parties}>
				{[l.issuer, l.supplier].map((p) => (
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
			</View>
			<View style={styles.notes}>
				{l.notes.map((n) => (
					<Text key={n}>{n}</Text>
				))}
			</View>
		</Page>
	);
}

/** Renders protocol `p` to PDF bytes (the same bytes again within one process). */
export async function renderProtocolPdf(p: ReverseChargeProtocol, filerVat: string): Promise<Uint8Array> {
	registerFonts();
	const at = new Date(`${p.issueDate}T00:00:00Z`);
	const buf = await renderToBuffer(
		<Document
			title={`ПРОТОКОЛ ${p.number}`}
			author="Alethia Labs"
			creator="Alethia"
			producer="Alethia"
			creationDate={at}
			modificationDate={at}
			language="bg"
		>
			<ProtocolPage l={protocolLayout(p, filerVat)} />
		</Document>,
	);
	return new Uint8Array(buf);
}
