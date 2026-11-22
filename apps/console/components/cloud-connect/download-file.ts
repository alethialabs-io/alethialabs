// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Downloads a file this console serves (a setup script, a Terraform module) under `name`. The
 * connect sheets each carried their own copy of these five lines.
 */
export function downloadFile(href: string, name: string): void {
	const link = document.createElement("a");
	link.href = href;
	link.download = name;
	document.body.appendChild(link);
	link.click();
	document.body.removeChild(link);
}
