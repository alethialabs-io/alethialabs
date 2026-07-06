// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Canned replies (macros) for the staff support console — reusable answer templates the
// composer can insert. A static catalog for now (zero migration); a DB-backed, editable
// macro store is a later enhancement. Bodies support `{{caseNumber}}` / `{{customerName}}`
// / `{{agentName}}` placeholders, filled by `applyMacro` at insert time.

/** One canned reply. */
export interface SupportMacro {
	id: string;
	title: string;
	body: string;
}

/** The built-in macro catalog. Grouped loosely by intent; extend as patterns emerge. */
export const SUPPORT_MACROS: SupportMacro[] = [
	{
		id: "ack",
		title: "Acknowledge + investigating",
		body: "Hi {{customerName}},\n\nThanks for reaching out — I'm looking into {{caseNumber}} now and will follow up shortly with an update.\n\n{{agentName}}",
	},
	{
		id: "need-info",
		title: "Request more detail",
		body: "Hi {{customerName}},\n\nTo dig into this, could you share a bit more detail — the affected project/cluster, the approximate time it happened, and any error message or job id you saw?\n\nThanks,\n{{agentName}}",
	},
	{
		id: "logs",
		title: "Ask for a job id / logs",
		body: "Could you send the job id (or a link to the job) for the run that failed? That lets me pull the runner logs and see exactly what happened.",
	},
	{
		id: "fixed",
		title: "Fix applied — please verify",
		body: "Hi {{customerName}},\n\nWe've applied a fix for this. Could you retry and confirm it's working on your end? I'll leave {{caseNumber}} open until you've had a chance to check.\n\n{{agentName}}",
	},
	{
		id: "resolving",
		title: "Resolving — reopen anytime",
		body: "Glad that's sorted! I'll mark {{caseNumber}} resolved — just reply here to reopen it if anything else comes up.\n\n{{agentName}}",
	},
];

/** Fills a macro body's placeholders with the case's concrete values. */
export function applyMacro(
	body: string,
	vars: { caseNumber?: number; customerName?: string; agentName?: string },
): string {
	const number =
		vars.caseNumber != null
			? `CASE-${String(vars.caseNumber).padStart(6, "0")}`
			: "your case";
	return body
		.replaceAll("{{caseNumber}}", number)
		.replaceAll("{{customerName}}", vars.customerName || "there")
		.replaceAll("{{agentName}}", vars.agentName || "Alethia Support");
}
