// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// One attachment allowlist for the picker and the upload route (G-05), and a file the browser gives
// no type judged by its extension (G-06).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	ATTACHMENT_ACCEPT,
	MAX_ATTACHMENT_BYTES,
	attachmentRejection,
	isAllowedContentType,
	resolveAttachmentType,
} from "@/components/support/attachment-policy";

describe("resolveAttachmentType", () => {
	it("keeps a listed type the browser reports", () => {
		const cases: Array<[string, string, string]> = [
			["shot.png", "image/png", "image/png"],
			["report.pdf", "application/pdf", "application/pdf"],
			["notes.txt", "text/plain", "text/plain"],
			["data.csv", "text/csv", "text/csv"],
			["dump.json", "application/json; charset=utf-8", "application/json"],
		];
		const wrong = cases.filter(([name, type, want]) => resolveAttachmentType(name, type) !== want);
		expect(wrong).toEqual([]);
	});

	it("judges a file the browser gives no type by its extension (G-06)", () => {
		expect(resolveAttachmentType("runner.log", "")).toBe("text/plain");
		expect(resolveAttachmentType("bundle.tar.gz", "application/octet-stream")).toBe("application/gzip");
		expect(resolveAttachmentType("README.MD", "")).toBe("text/markdown");
	});

	it("refuses a type that is not listed, whatever the extension says", () => {
		expect(resolveAttachmentType("page.html", "text/html")).toBeNull();
		expect(resolveAttachmentType("evil.log", "text/html")).toBeNull();
		expect(resolveAttachmentType("setup.exe", "")).toBeNull();
		expect(resolveAttachmentType("noextension", "")).toBeNull();
	});
});

describe("isAllowedContentType", () => {
	it("allows every image type and the listed documents and archives, nothing else", () => {
		expect(isAllowedContentType("image/webp")).toBe(true);
		expect(isAllowedContentType("application/zip")).toBe(true);
		expect(isAllowedContentType("application/javascript")).toBe(false);
	});
});

describe("attachmentRejection", () => {
	it("says why a file cannot be attached, and nothing for one that can", () => {
		expect(attachmentRejection({ name: "a.log", type: "", size: 10 })).toBeNull();
		expect(attachmentRejection({ name: "a.exe", type: "", size: 10 })).toContain("can't be attached");
		expect(attachmentRejection({ name: "a.txt", type: "text/plain", size: 0 })).toContain("empty");
		expect(
			attachmentRejection({ name: "a.txt", type: "text/plain", size: MAX_ATTACHMENT_BYTES + 1 }),
		).toContain("10 MB");
	});
});

describe("the picker's accept list", () => {
	it("offers the extensions it accepts without a type", () => {
		expect(ATTACHMENT_ACCEPT.split(",")).toEqual(expect.arrayContaining([".log", ".gz", "image/*", "text/plain"]));
		expect(ATTACHMENT_ACCEPT).not.toContain("text/*");
	});
});

describe("the upload route reads the same policy (G-05)", () => {
	it("imports the resolver instead of keeping a list of its own", () => {
		const route = readFileSync(
			join(__dirname, "../../../app/api/support/cases/[id]/attachments/route.ts"),
			"utf8",
		);
		expect(route).toContain('from "@/components/support/attachment-policy"');
		expect(route).toContain("resolveAttachmentType(");
		expect(route).not.toMatch(/ALLOWED_EXACT|isAllowedContentType\s*\(/);
	});
});
