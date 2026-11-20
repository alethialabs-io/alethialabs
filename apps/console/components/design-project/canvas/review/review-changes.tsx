"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button } from "@repo/ui/button";
import { NODE_REGISTRY } from "@/components/design-project/canvas/graph/node-registry";
import { useIdentities } from "@/lib/canvas/store/canvas-store-provider";
import type { FieldChange, PendingChange, StagedOperation } from "@/lib/canvas/store/types";
import { fieldLabel, formatValue } from "./changeset-status";

/** A change's mark and word. State is the glyph plus the word, never a hue. */
const OP: Record<PendingChange["op"], { glyph: string; word: string }> = {
	new: { glyph: "+", word: "New" },
	modified: { glyph: "~", word: "Edited" },
	removed: { glyph: "−", word: "Removed" },
};

/** One card's rows of the field diff, kept together. */
interface ChangeGroup {
	head: FieldChange;
	fields: FieldChange[];
}

/** The field diff grouped by card, in the order the diff lists the cards. */
function groupByCard(rows: readonly FieldChange[]): ChangeGroup[] {
	const groups: ChangeGroup[] = [];
	for (const row of rows) {
		const last = groups.at(-1);
		if (last && last.head.id === row.id) {
			last.fields.push(row);
			continue;
		}
		groups.push({ head: row, fields: [row] });
	}
	return groups;
}

/**
 * A card's own name, or null when it has none: a kind with one card per environment (the cluster)
 * is reported under its kind, and repeating that after the kind's label says nothing.
 */
function ownName(change: Pick<PendingChange, "kind" | "name">): string | null {
	return change.name === change.kind ? null : change.name;
}

/** The square that carries a change's glyph. */
function OpMark({ op }: { op: PendingChange["op"] }) {
	return (
		<span
			aria-hidden
			className="flex size-4 shrink-0 items-center justify-center border border-border font-mono text-ui-xs leading-none text-muted-foreground"
		>
			{OP[op].glyph}
		</span>
	);
}

/**
 * Step one of the review: what changed in the design, from the board's own diff. One block per
 * card; an edited card lists each changed field with the saved value and the drafted one. Every row
 * can be taken back on its own, which is an ordinary edit: it is one undo step, and it makes a plan
 * computed before it out of date.
 */
export function ReviewChanges({
	fieldChanges,
	operations,
	saved,
	onRevert,
	onUnstage,
}: {
	fieldChanges: readonly FieldChange[];
	operations: readonly StagedOperation[];
	/** The changes the last Run plan saved: no longer pending, still part of this review. */
	saved: readonly PendingChange[];
	onRevert: (change: FieldChange) => void;
	onUnstage: (operationId: string) => void;
}) {
	const identities = useIdentities();
	const groups = groupByCard(fieldChanges);

	/** A field's value as shown: a cloud account by its name, anything else as it is. */
	const shown = (field: string | null, value: unknown): string => {
		if (field === "cloud_identity_id") {
			if (typeof value !== "string" || value === "") return "the project's account";
			return identities.find((i) => i.id === value)?.name ?? "another account";
		}
		return formatValue(value);
	};

	if (groups.length === 0 && operations.length === 0) {
		return (
			<div className="space-y-2">
				<p className="text-ui-md text-muted-foreground">
					{saved.length > 0
						? "Nothing is pending. The changes below were saved by the last plan."
						: "Nothing is pending. A plan here is a plan of the saved design."}
				</p>
				<SavedInReview saved={saved} />
			</div>
		);
	}

	return (
		<div className="space-y-3">
			<ul className="space-y-2" aria-label="Pending design changes">
				{groups.map(({ head, fields }) => {
					const def = NODE_REGISTRY[head.kind];
					const Icon = def.icon;
					const name = ownName(head);
					const subject = name ? `${def.label} ${name}` : def.label;
					return (
						<li key={head.id} className="border border-border bg-surface-sunken">
							<div className="flex items-center gap-2 px-2.5 py-2">
								<OpMark op={head.op} />
								<Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
								<span className="min-w-0 flex-1 truncate text-ui-md">
									<span className="text-muted-foreground">{def.label}</span>
									{name ? ` ${name}` : null}
								</span>
								<span className="shrink-0 font-mono text-ui-2xs uppercase tracking-wide text-muted-foreground">
									{OP[head.op].word}
								</span>
								{head.op !== "modified" && (
									<Button
										type="button"
										variant="ghost"
										size="xs"
										aria-label={
											head.op === "new"
												? `Discard new ${subject}`
												: `Restore removed ${subject}`
										}
										onClick={() => onRevert(head)}
									>
										{head.op === "new" ? "Discard" : "Restore"}
									</Button>
								)}
							</div>
							{head.op === "modified" && (
								<ul className="border-t border-border">
									{fields.map((row) => {
										const label = fieldLabel(row.field ?? "");
										return (
											<li
												key={row.field ?? "card"}
												className="flex items-center gap-2 px-2.5 py-1.5 pl-9"
											>
												<span className="w-32 shrink-0 truncate text-ui-sm text-muted-foreground">
													{label}
												</span>
												<span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5 font-mono text-ui-xs">
													<span className="sr-only">was</span>
													<span className="break-all text-muted-foreground line-through">
														{shown(row.field, row.before)}
													</span>
													<span aria-hidden>→</span>
													<span className="sr-only">now</span>
													<span className="break-all">{shown(row.field, row.after)}</span>
												</span>
												<Button
													type="button"
													variant="ghost"
													size="xs"
													aria-label={`Discard the change to ${label} on ${subject}`}
													onClick={() => onRevert(row)}
												>
													Discard
												</Button>
											</li>
										);
									})}
								</ul>
							)}
						</li>
					);
				})}
				{operations.map((operation) => (
					<li
						key={operation.id}
						className="flex items-center gap-2 border border-border bg-surface-sunken px-2.5 py-2"
					>
						<span
							aria-hidden
							className="flex size-4 shrink-0 items-center justify-center border border-border font-mono text-ui-xs leading-none text-muted-foreground"
						>
							○
						</span>
						<span className="min-w-0 flex-1 text-ui-md">
							<span className="block truncate">{operation.summary}</span>
							<span className="block text-ui-sm text-muted-foreground">
								Applies directly to the cluster, outside the plan.
							</span>
						</span>
						<Button
							type="button"
							variant="ghost"
							size="xs"
							aria-label={`Discard: ${operation.summary}`}
							onClick={() => onUnstage(operation.id)}
						>
							Discard
						</Button>
					</li>
				))}
			</ul>
			<SavedInReview saved={saved} />
		</div>
	);
}

/** The changes a Run plan already saved, listed so the review still shows what it is a review of. */
function SavedInReview({ saved }: { saved: readonly PendingChange[] }) {
	if (saved.length === 0) return null;
	return (
		<div>
			<p className="font-mono text-ui-2xs uppercase tracking-wide text-muted-foreground">
				Saved in this review
			</p>
			<ul className="mt-1 space-y-1" aria-label="Changes saved in this review">
				{saved.map((change) => (
					<li
						key={`${change.op}-${change.id}`}
						className="flex items-center gap-2 text-ui-sm text-muted-foreground"
					>
						<OpMark op={change.op} />
						<span className="min-w-0 flex-1 truncate">
							{NODE_REGISTRY[change.kind].label}
							{ownName(change) ? ` ${ownName(change)}` : null}
						</span>
						<span className="shrink-0 font-mono text-ui-2xs uppercase tracking-wide">
							{OP[change.op].word}
						</span>
					</li>
				))}
			</ul>
		</div>
	);
}
