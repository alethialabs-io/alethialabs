// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

export function getSection(path: string | undefined) {
	if (!path) return "console";
	const [dir] = path.split("/", 1);
	if (!dir) return "console";
	return (
		{
			console: "console",
			cli: "cli",
			runner: "runner",
			concepts: "concepts",
		}[dir] ?? "console"
	);
}