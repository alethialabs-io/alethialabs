// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The record layouts of the NRA VAT e-filing files, as data (#7457). Every field here is copied from
// the published regulation, field by field, and docs/legal/NRA_FILE_FORMATS.md cites each one:
//  - DEKLAR.TXT, PRODAGBI.TXT, POKUPKI.TXT: ППЗДДС Приложение № 12 към чл. 113, ал. 4;
//  - VIES.TXT: ППЗДДС Приложение № 15 към чл. 118, ал. 1.
//
// THE ORDER OF THE FIELDS IS THE ORDER OF THE ROWS in the appendix's table. Appendix 12 says there
// are no separators between the fields of a record, so a field's position is the sum of the widths
// before it. The tables are not in code order (DEKLAR puts 01-20 after 01-01, POKUPKI puts 03-02
// before 03-01), and that order is kept exactly as printed.
//
// A field the regulation does not settle is marked `verified: false`, and the record writer
// (record.ts) refuses a layout that has one: a plausible line the NRA rejects, or worse accepts with
// a shifted column, is worse than no file. Today every field below is verified against the text.

/** How a field's content is written (Appendix 12, "Изисквания към съдържанието на полетата"). */
export type FieldFormat =
	/** "Символен": cp-1251 characters 0x20-0xFF, left-aligned, space-padded. */
	| "symbolic"
	/** "Цифров" holding a count or a sequence number: digits only, right-aligned. */
	| "integer"
	/** "Цифров" holding a value: digits, "." before the cents, an optional minus, right-aligned. */
	| "amount"
	/** "Цифров" coefficient (01-33): a value between 0.00 and 1.00. */
	| "coefficient"
	/** "Дата": dd/mm/yyyy. */
	| "date"
	/** The tax period of Appendix 12: ггггмм. */
	| "periodYm"
	/** The tax period of Appendix 15: мм/гггг. */
	| "periodMy"
	/** A section code of Appendix 15 (VHR, VDR …), a fixed Latin literal. */
	| "literal";

/** One field of a fixed-width record. */
export interface FieldSpec {
	/** The code the regulation gives the field ("01-20"), or the section's field number ("VIR.6"). */
	code: string;
	/** The field's name as printed in the appendix. */
	name: string;
	/** Its width in characters (= bytes, in cp-1251). */
	width: number;
	format: FieldFormat;
	/** For a `literal` field: its only value. */
	literal?: string;
	/** False when the regulation does not settle the field; the writer then refuses the layout. */
	verified: boolean;
}

/** Shorthand for a verified field. */
function f(code: string, name: string, width: number, format: FieldFormat, literal?: string): FieldSpec {
	return { code, name, width, format, verified: true, ...(literal ? { literal } : {}) };
}

/** Appendix 12: "Файлът DEKLAR.ТХТ … съдържа единствен запис (ред) със следната структура". */
export const DEKLAR_FIELDS: readonly FieldSpec[] = [
	f("00-01", "Идентификационен номер по ДДС на лицето", 15, "symbolic"),
	f("00-02", "Наименование на лицето", 50, "symbolic"),
	f("00-03", "Данъчен период", 6, "periodYm"),
	f("00-04", "Лице, подаващо данните (ЕГН/име)", 50, "symbolic"),
	f("00-05", "Брой документи в дневника за продажби", 15, "integer"),
	f("00-06", "Брой документи в дневника за покупки", 15, "integer"),
	f("01-01", "Общ размер на данъчните основи за облагане с ДДС", 15, "amount"),
	f("01-20", "Всичко начислен ДДС", 15, "amount"),
	f("01-11", "Данъчна основа на облагаемите доставки със ставка 20 %", 15, "amount"),
	f("01-21", "Начислен ДДС 20 %", 15, "amount"),
	f("01-12", "Данъчна основа на ВОП и на получени доставки по чл. 82, ал. 2 - 6 от ЗДДС", 15, "amount"),
	f("01-22", "Начислен данък за ВОП и за получени доставки по чл. 82, ал. 2 - 6 от ЗДДС", 15, "amount"),
	f("01-23", "Начислен данък за доставки на стоки и услуги за лични нужди", 15, "amount"),
	f("01-13", "Данъчна основа на облагаемите доставки със ставка 9 %", 15, "amount"),
	f("01-24", "Начислен ДДС 9 %", 15, "amount"),
	f("01-14", "Данъчна основа, подлежаща на облагане със ставка 0 % по глава трета от ЗДДС", 15, "amount"),
	f("01-15", "Данъчна основа на доставките със ставка 0 % за ВОД на стоки", 15, "amount"),
	f("01-16", "Данъчна основа на доставки, подлежаща на облагане с 0 % по чл. 140, 146 и чл. 173 ЗДДС", 15, "amount"),
	f("01-17", "Данъчна основа на доставки на услуги по чл. 21, ал. 2 ЗДДС в друга държава членка", 15, "amount"),
	f("01-18", "Данъчна основа на доставки по чл. 69, ал. 2 ЗДДС", 15, "amount"),
	f("01-19", "Данъчна основа на освободени доставки и освободените ВОП", 15, "amount"),
	f("01-30", "Данъчна основа и данък на получените доставки … без право на данъчен кредит или без данък", 15, "amount"),
	f("01-31", "Данъчна основа на получените доставки … с право на пълен данъчен кредит", 15, "amount"),
	f("01-41", "Начислен ДДС с право на пълен данъчен кредит", 15, "amount"),
	f("01-32", "Данъчна основа на получените доставки … с право на частичен данъчен кредит", 15, "amount"),
	f("01-42", "Начислен ДДС с право на частичен данъчен кредит", 15, "amount"),
	f("01-43", "Годишна корекция по чл. 73, ал. 8 (+/-) ЗДДС", 15, "amount"),
	f("01-33", "Коефициент по чл. 73, ал. 5 ЗДДС", 4, "coefficient"),
	f("01-40", "Общо данъчен кредит (кл. 41 + кл. 42 x кл. 33 + кл. 43)", 15, "amount"),
	f("01-50", "ДДС за внасяне (кл. 20 - кл. 40) >= 0", 15, "amount"),
	f("01-60", "ДДС за възстановяване (кл. 20 - кл. 40) < 0", 15, "amount"),
	f("01-70", "Данък за внасяне от кл. 50, приспаднат по реда на чл. 92, ал. 1 ЗДДС", 15, "amount"),
	f("01-71", "Данък за внасяне от кл. 50, внесен ефективно", 15, "amount"),
	f("01-80", "ДДС, подлежащ на възстановяване, съгласно чл. 92, ал. 1 ЗДДС", 15, "amount"),
	f("01-81", "ДДС, подлежащ на възстановяване, съгласно чл. 92, ал. 3 ЗДДС", 15, "amount"),
	f("01-82", "ДДС, подлежащ на възстановяване, съгласно чл. 92, ал. 4 ЗДДС", 15, "amount"),
];

/** Appendix 12: "Всеки документ от дневника се описва с един запис (ред) във файла PRODAGBI.ТХТ". */
export const PRODAGBI_FIELDS: readonly FieldSpec[] = [
	f("02-00", "Идентификационен номер по ДДС на лицето", 15, "symbolic"),
	f("02-01", "Данъчен период", 6, "periodYm"),
	f("02-02", "Клон/обособено звено", 4, "integer"),
	f("02-03", "Пореден номер на документа в дневника", 15, "integer"),
	f("02-04", "Вид на документа", 2, "symbolic"),
	f("02-05", "Номер на документа", 20, "symbolic"),
	f("02-06", "Дата на документа", 10, "date"),
	f("02-07", "Идентификационен номер на контрагента (получател)", 15, "symbolic"),
	f("02-08", "Име на контрагента (получател)", 50, "symbolic"),
	f("02-09", "Вид на стоката или обхват и вид на услугата", 30, "symbolic"),
	f("02-10", "Общ размер на данъчните основи за облагане с ДДС", 15, "amount"),
	f("02-20", "Всичко начислен ДДС", 15, "amount"),
	f("02-11", "Данъчна основа на облагаемите доставки със ставка 20 %", 15, "amount"),
	f("02-21", "Начислен ДДС 20 %", 15, "amount"),
	f("02-12", "ДО на ВОП", 15, "amount"),
	f("02-26", "ДО по получените доставки по чл. 82, ал. 2 - 5 ЗДДС", 15, "amount"),
	f("02-22", "Начислен ДДС за ВОП и за получени доставки по чл. 82, ал. 2 - 5 ЗДДС", 15, "amount"),
	f("02-23", "Начислен данък за доставки на стоки и услуги за лични нужди", 15, "amount"),
	f("02-13", "ДО на облагаемите доставки със ставка 9 %", 15, "amount"),
	f("02-24", "Начислен ДДС 9 %", 15, "amount"),
	f("02-14", "ДО на доставките със ставка 0 % по глава трета от ЗДДС", 15, "amount"),
	f("02-15", "ДО на доставките със ставка 0 % на ВОД на стоки", 15, "amount"),
	f("02-16", "ДО на доставките със ставка 0 % по чл. 140, чл. 146, ал. 1 и чл. 173 ЗДДС", 15, "amount"),
	f("02-17", "Данъчна основа на доставки на услуги по чл. 21, ал. 2 ЗДДС в друга държава членка", 15, "amount"),
	f("02-18", "Данъчна основа на доставки по чл. 69, ал. 2 ЗДДС", 15, "amount"),
	f("02-19", "ДО на освободени доставки и освободените ВОП", 15, "amount"),
	f("02-25", "ДО на доставки като посредник в тристранни операции", 15, "amount"),
	f("02-27", "Доставка по чл. 163а или внос по чл. 167а от ЗДДС", 2, "symbolic"),
];

/** Appendix 12: "Всеки документ от дневника се описва с един запис (ред) във файла POKUPKI.ТХТ". */
export const POKUPKI_FIELDS: readonly FieldSpec[] = [
	f("03-02", "Идентификационен номер по ДДС на лицето", 15, "symbolic"),
	f("03-01", "Данъчен период", 6, "periodYm"),
	f("03-03", "Клон/обособено звено", 4, "integer"),
	f("03-04", "Пореден номер на документа в дневника", 15, "integer"),
	f("03-05", "Вид на документа", 2, "symbolic"),
	f("03-06", "Номер на документа", 20, "symbolic"),
	f("03-07", "Дата на документа", 10, "date"),
	f("03-08", "Идентификационен номер на контрагента (доставчик)", 15, "symbolic"),
	f("03-09", "Име на контрагента (доставчик)", 50, "symbolic"),
	f("03-10", "Вид на стоката или обхват и вид на услугата", 30, "symbolic"),
	f("03-30", "Данъчна основа и данък на получените доставки … без право на данъчен кредит или без данък", 15, "amount"),
	f("03-31", "Данъчна основа на получените доставки … с право на пълен данъчен кредит", 15, "amount"),
	f("03-41", "ДДС с право на пълен данъчен кредит", 15, "amount"),
	f("03-32", "Данъчна основа на получените доставки … с право на частичен данъчен кредит", 15, "amount"),
	f("03-42", "ДДС с право на частичен данъчен кредит", 15, "amount"),
	f("03-43", "Годишна корекция по чл. 73, ал. 8 ЗДДС", 15, "amount"),
	f("03-44", "ДО при придобиване на стоки от посредник в тристранна операция", 15, "amount"),
	f("03-45", "Доставка по чл. 163а или внос по чл. 167а от ЗДДС", 2, "symbolic"),
];

/** Appendix 15, section 1, "Основен запис". */
export const VIES_VHR_FIELDS: readonly FieldSpec[] = [
	f("VHR.1", "Код на секцията \"Основен запис\"", 3, "literal", "VHR"),
	f("VHR.2", "Данъчен период", 7, "periodMy"),
	f("VHR.3", "Общ брой редове в раздел \"В\" на декларацията", 5, "integer"),
];

/** Appendix 15, section 2, "Декларатор". */
export const VIES_VDR_FIELDS: readonly FieldSpec[] = [
	f("VDR.1", "Код на секцията \"Декларатор\"", 3, "literal", "VDR"),
	f("VDR.2", "ЕГН/ЛНЧ/служебен номер от регистър на НАП на лицето, подаващо декларацията", 15, "symbolic"),
	f("VDR.3", "Трите имена на лицето, подаващо декларацията", 150, "symbolic"),
	f("VDR.4", "Град от адреса за кореспонденция на лицето, подаващо декларацията", 50, "symbolic"),
	f("VDR.5", "Пощенски код от адреса за кореспонденция на лицето, подаващо декларацията", 4, "integer"),
	f("VDR.6", "Адрес за кореспонденция (кв., ж.к., ул., №) на лицето, подаващо декларацията", 150, "symbolic"),
	f("VDR.7", "Качество на лицето, подаващо декларацията", 1, "symbolic"),
];

/** Appendix 15, section 3, "Регистрирано лице". */
export const VIES_VTR_FIELDS: readonly FieldSpec[] = [
	f("VTR.1", "Код на секцията \"Регистрирано лице\"", 3, "literal", "VTR"),
	f("VTR.2", "Идентификационен номер по ДДС на регистрираното лице", 15, "symbolic"),
	f("VTR.3", "Име на регистрираното лице", 150, "symbolic"),
	f("VTR.4", "Адрес за кореспонденция", 200, "symbolic"),
];

/** Appendix 15, section 4, "Общ оборот". */
export const VIES_TTR_FIELDS: readonly FieldSpec[] = [
	f("TTR.1", "Код на секцията \"Общ оборот\"", 3, "literal", "TTR"),
	f("TTR.2", "Данъчна основа общо (сума по к3 + к4 + к5)", 12, "amount"),
	f("TTR.3", "Данъчна основа на ВОД (сума по к3)", 12, "amount"),
];

/**
 * Appendix 15, section 5, "ВОД". The table's width column is headed "Максимална дължина", but the
 * appendix states that in VIES.TXT "полетата във файла са с фиксирана дължина" and that unused
 * positions are spaces, so the widths are written as fixed (NRA_FILE_FORMATS.md, VIES §5).
 */
export const VIES_VIR_FIELDS: readonly FieldSpec[] = [
	f("VIR.1", "Код на секцията \"ВОД\"", 3, "literal", "VIR"),
	f("VIR.2", "Номер на ред", 5, "integer"),
	f("VIR.3", "VIN номер на чуждестранния контрагент вкл. знакът на държавата членка", 15, "symbolic"),
	f("VIR.4", "Обща стойност на данъчната основа за доставки на стоки", 12, "amount"),
	f("VIR.5", "Обща стойност на данъчната основа за тристранни сделки", 12, "amount"),
	f("VIR.6", "Обща стойност на данъчната основа за доставени услуги по чл. 21, ал. 2 ЗДДС", 12, "amount"),
	f("VIR.7", "Данъчен период, през който данъкът е станал изискуем", 7, "periodMy"),
];

/** The total width of a record: the sum of its fields' widths. */
export function recordWidth(fields: readonly FieldSpec[]): number {
	return fields.reduce((n, field) => n + field.width, 0);
}
