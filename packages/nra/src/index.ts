// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// @repo/nra: the monthly VAT filing package of a company registered under чл. 100, ал. 1 ЗДДС —
// DEKLAR.TXT, PRODAGBI.TXT, POKUPKI.TXT, VIES.TXT (ППЗДДС Приложения № 12 и № 15), the чл. 117
// protocols and SUMMARY.md — from two JSON inputs (input.ts). Pure: no database, no network, no
// secrets, no PDF library (a protocol renderer is injected). Specification:
// docs/legal/NRA_FILE_FORMATS.md.

export {
	checkNraInput,
	checkSalesFile,
	type NraInput,
	type NraInputFile,
	nraInputSchema,
	type NraPurchase,
	type NraSupplier,
	type Parsed,
	parseNraInput,
	parseProtocolRequest,
	parseSalesFile,
	PURCHASE_TREATMENTS,
	type ProtocolRequest,
	protocolRequestSchema,
	type PurchaseTreatment,
	SALE_TREATMENTS,
	type SalesDocument,
	type SalesFile,
	type SalesFileInput,
	salesFileSchema,
	type SaleTreatment,
	toCents,
} from "./input";
export { buildNraFiles, type DeklarCells, deklarCells, FILER_NAME, type NraFiles } from "./files";
export { DEKLAR_FIELDS, type FieldSpec, POKUPKI_FIELDS, PRODAGBI_FIELDS, recordWidth } from "./layout";
export {
	addDays,
	buildNraMonth,
	buildSingleProtocol,
	convertToEurCents,
	type MonthWindow,
	monthWindow,
	type NraMonth,
	type ReverseChargeProtocol,
	VAT_RATE_PERCENT,
	vatOf,
} from "./month";
export { buildNraPackage, type NraOutputFile, type NraPackage } from "./package";
export { type ProtocolLayout, type ProtocolPair, protocolLayout, type ProtocolRenderer, protocolText } from "./protocol";
export { centsToDecimal, NraError } from "./record";
export { ACCOUNTANT_QUESTIONS, dueDate } from "./summary";
export { euVatNumberOf, isEuCountry, NO_EU_VAT_ID } from "./vat-number";
