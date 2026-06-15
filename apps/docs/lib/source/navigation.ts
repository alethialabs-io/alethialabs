// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

export function getSection(path: string | undefined) {
	if (!path) return "trellis";
	const [dir] = path.split("/", 1);
	if (!dir) return "trellis";
	return (
		{
			trellis: "trellis",
			grape: "grape",
			tendril: "tendril",
			concepts: "concepts",
		}[dir] ?? "trellis"
	);
}