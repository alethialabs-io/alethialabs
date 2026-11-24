// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Writes fixed-width records of the NRA files and encodes them to cp-1251 (#7457). The rules are
// ППЗДДС Приложение № 12, "Изисквания към съдържанието на полетата" (and the same wording in
// Приложение № 15 for VIES):
//  - every field has its full width; unused positions and an empty field are spaces;
//  - "Символен": cp-1251 characters 0x20-0xFF, left-aligned, never padded with zeros;
//  - "Цифров": digits, right-aligned; a value may hold "." before the cents and a minus sign, and
//    is not padded with zeros ("100.00", "-200.00");
//  - "Дата": dd/mm/yyyy; the period: ггггмм (Appendix 12) or мм/гггг (Appendix 15);
//  - records end with CR LF; the files are cp-1251.
//
// AMOUNTS ARE EURO. Appendix 12 still says "Попълнените стойности трябва да са в български левове",
// but the Euro Introduction Act, Art. 50(1), puts the values of a tax declaration for a period in the
// currency that was official at the end of that period: the euro, for every period from January
// 2026 (NRA_FILE_FORMATS.md, "Currency").
//
// Anything that does not fit is REFUSED with an NraError, never cut or padded into a plausible
// shape: an identifier, a number, a date or an amount that overflows its field. Free text (a name, a
// description) is the one exception: it is cut to the field's width, and the caller records that it
// did so, because Appendix 12 fixes the width and the full text is on the document itself.

import type { FieldSpec } from "./layout";

/** A refusal: the input cannot be written into the NRA files as they are specified. */
export class NraError extends Error {
	override name = "NraError";
}

/** The value of one field: text, an integer (a count, or euro cents for an amount), or nothing. */
export type FieldValue = string | number | null;

/** cp-1251 byte for each Unicode code point above 0x7F, built from the platform's decoder. */
const CP1251: ReadonlyMap<number, number> = (() => {
	const decoder = new TextDecoder("windows-1251");
	const map = new Map<number, number>();
	for (let byte = 0x80; byte <= 0xff; byte++) {
		const cp = decoder.decode(new Uint8Array([byte])).codePointAt(0) ?? 0;
		// 0x98 is undefined in cp-1251; WHATWG decodes it to the C1 control U+0098. Not a character.
		if (cp >= 0x80 && cp <= 0x9f) continue;
		map.set(cp, byte);
	}
	return map;
})();

/** True when every character of `text` is printable cp-1251 (code 0x20-0xFF, as Appendix 12 asks). */
export function isCp1251(text: string): boolean {
	for (const ch of text) {
		const cp = ch.codePointAt(0) ?? 0;
		if (cp >= 0x20 && cp < 0x7f) continue;
		if (!CP1251.has(cp)) return false;
	}
	return true;
}

/** `text` as cp-1251 bytes; refuses a character the code page does not have (no "?" substitution). */
export function encodeCp1251(text: string): Uint8Array {
	const out: number[] = [];
	for (const ch of text) {
		const cp = ch.codePointAt(0) ?? 0;
		if (cp === 0x0d || cp === 0x0a || (cp >= 0x20 && cp < 0x7f)) out.push(cp);
		else {
			const byte = CP1251.get(cp);
			if (byte === undefined) throw new NraError(`"${ch}" (U+${cp.toString(16).toUpperCase().padStart(4, "0")}) has no cp-1251 byte`);
			out.push(byte);
		}
	}
	return new Uint8Array(out);
}

/** Latin letters that do not decompose into a base letter and a mark. */
const LATIN_SPECIAL: Readonly<Record<string, string>> = {
	ß: "ss",
	ẞ: "SS",
	Æ: "AE",
	æ: "ae",
	Ø: "O",
	ø: "o",
	Œ: "OE",
	œ: "oe",
	Ł: "L",
	ł: "l",
	Đ: "D",
	đ: "d",
	Þ: "Th",
	þ: "th",
	ı: "i",
};

/**
 * Free text made printable cp-1251: whitespace runs become one space, a Latin letter with a
 * diacritic that cp-1251 lacks loses the mark ("Müller" → "Muller", "Straße" → "Strasse"), and any
 * character still outside the code page is refused. Returns whether anything changed, so the caller
 * can say so in the summary.
 */
export function toCp1251Text(text: string): { text: string; changed: boolean } {
	const spaced = text.replace(/\s+/g, " ").trim();
	let out = "";
	for (const ch of spaced) {
		if (isCp1251(ch)) {
			out += ch;
			continue;
		}
		const special = LATIN_SPECIAL[ch];
		if (special !== undefined) {
			out += special;
			continue;
		}
		const base = ch.normalize("NFD").replace(/\p{M}+/gu, "");
		if (base !== ch && isCp1251(base)) out += base;
		else throw new NraError(`"${ch}" in "${text}" cannot be written in cp-1251`);
	}
	return { text: out, changed: out !== text };
}

/** The decimal form of an amount in euro cents: 12345 → "123.45", -500 → "-5.00". */
export function centsToDecimal(cents: number): string {
	if (!Number.isSafeInteger(cents)) throw new NraError(`amount ${cents} is not a whole number of cents`);
	const sign = cents < 0 ? "-" : "";
	const abs = Math.abs(cents);
	return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** YYYY-MM-DD → dd/mm/yyyy; refuses anything that is not a real calendar date. */
function bgSlashDate(iso: string): string {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
	const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
	if (!m || !d || d.toISOString().slice(0, 10) !== iso) throw new NraError(`"${iso}" is not a date (YYYY-MM-DD)`);
	return `${m[3]}/${m[2]}/${m[1]}`;
}

/** YYYY-MM → its two parts; refuses anything else. */
function yearMonth(ym: string): { y: string; m: string } {
	const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(ym);
	if (!match) throw new NraError(`"${ym}" is not a period (YYYY-MM)`);
	return { y: match[1] ?? "", m: match[2] ?? "" };
}

/** The text of one field before padding; null for an empty field. */
function content(field: FieldSpec, value: FieldValue): string | null {
	if (field.format === "literal") return field.literal ?? "";
	if (value === null || value === "") return null;
	switch (field.format) {
		case "symbolic":
			if (typeof value !== "string") throw new NraError(`${field.code} takes text, got ${value}`);
			if (!isCp1251(value)) throw new NraError(`${field.code} holds a character outside cp-1251: "${value}"`);
			return value;
		case "integer":
			if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
				throw new NraError(`${field.code} takes a whole number >= 0, got ${value}`);
			}
			return String(value);
		case "amount":
			if (typeof value !== "number") throw new NraError(`${field.code} takes euro cents, got "${value}"`);
			return centsToDecimal(value);
		case "coefficient":
			if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
				throw new NraError(`${field.code} takes hundredths between 0 and 100, got ${value}`);
			}
			return centsToDecimal(value);
		case "date":
			if (typeof value !== "string") throw new NraError(`${field.code} takes a date, got ${value}`);
			return bgSlashDate(value);
		case "periodYm": {
			if (typeof value !== "string") throw new NraError(`${field.code} takes a period, got ${value}`);
			const p = yearMonth(value);
			return `${p.y}${p.m}`;
		}
		case "periodMy": {
			if (typeof value !== "string") throw new NraError(`${field.code} takes a period, got ${value}`);
			const p = yearMonth(value);
			return `${p.m}/${p.y}`;
		}
	}
}

/** True for the formats Appendix 12 right-aligns. */
function rightAligned(field: FieldSpec): boolean {
	return field.format === "integer" || field.format === "amount" || field.format === "coefficient";
}

/**
 * One record (without its line end): every field of `fields`, in order, at its width. `values` must
 * name every field except a `literal` one, and nothing else, so a field cannot be forgotten or
 * misspelt. Refuses a layout with an unverified field, and a value that does not fit.
 */
export function renderRecord(fields: readonly FieldSpec[], values: ReadonlyMap<string, FieldValue>): string {
	const unverified = fields.filter((field) => !field.verified);
	if (unverified.length) {
		throw new NraError(`the layout has unverified field(s) ${unverified.map((u) => u.code).join(", ")}; refusing to write it`);
	}
	const known = new Set(fields.map((field) => field.code));
	for (const code of values.keys()) if (!known.has(code)) throw new NraError(`no field ${code} in this record`);
	let line = "";
	for (const field of fields) {
		if (field.format !== "literal" && !values.has(field.code)) throw new NraError(`field ${field.code} was not given a value`);
		const text = content(field, values.get(field.code) ?? null) ?? "";
		if (text.length > field.width) {
			throw new NraError(`${field.code} (${field.name}) is ${field.width} characters; "${text}" is ${text.length}`);
		}
		line += rightAligned(field) ? text.padStart(field.width, " ") : text.padEnd(field.width, " ");
	}
	return line;
}

/** The records as one cp-1251 file, each line ended by CR LF (Appendix 12); no records → no bytes. */
export function encodeRecords(lines: readonly string[]): Uint8Array {
	return encodeCp1251(lines.map((l) => `${l}\r\n`).join(""));
}

/** Free text cut to `width` characters: the content of a name or description field. */
export function fitText(text: string, width: number): { text: string; cut: boolean } {
	return text.length > width ? { text: text.slice(0, width).trimEnd(), cut: true } : { text, cut: false };
}
