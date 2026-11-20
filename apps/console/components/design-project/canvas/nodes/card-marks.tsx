"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The marks a card carries beside its status, and the sentence a screen reader hears for it
// (#6835).
//
// The design system is grayscale, so no mark is a hue. Each is a SHAPE and a WORD: a pending change
// is a dashed outline with a flag reading "+ New" or "~ Edited"; a validation problem is a triangle
// with the problem's own sentence. The same facts, in the same words, make the card's spoken
// description, so what the eye reads and what is announced cannot drift apart.
//
// The pending changes and the connections are facts about the whole board, so the board works them
// out once and publishes them here; a card looks its own up by id. A card rendered without the
// board (a test, a preview) reads the empty default and draws no mark.

import { TriangleAlert } from "lucide-react";
import { createContext, useContext } from "react";
import { cn } from "@repo/ui/utils";
import { cardDescriptionId } from "./node-name";

/** A pending change a card can show. A removed node has no card to show it on. */
export type PendingMarkOp = "new" | "modified";

/** What the board knows about its cards beyond each one's own config. */
export interface BoardMarks {
	/** The pending change of each changed design node, by node id. */
	pending: ReadonlyMap<string, PendingMarkOp>;
	/** The titles of the cards each card is connected to, by card id. */
	connections: ReadonlyMap<string, readonly string[]>;
}

const NO_MARKS: BoardMarks = { pending: new Map(), connections: new Map() };

/** The board's marks. Provided by `CanvasFlow`; empty anywhere else. */
export const BoardMarksContext = createContext<BoardMarks>(NO_MARKS);

/** The marks of the board in scope. */
export function useBoardMarks(): BoardMarks {
	return useContext(BoardMarksContext);
}

/** How a pending change reads: its glyph, its word and its spoken sentence. */
export const PENDING_MARK: Record<PendingMarkOp, { glyph: string; word: string; spoken: string }> = {
	new: { glyph: "+", word: "New", spoken: "New, not saved yet" },
	modified: { glyph: "~", word: "Edited", spoken: "Edited, not saved yet" },
};

/** The outline a card with a pending change wears: dashed, so it reads without a colour. */
export const PENDING_OUTLINE_CLASS =
	"outline outline-1 outline-dashed outline-offset-[3px] outline-foreground";

/**
 * The flag on a card with a pending change, sitting on the card's top-left corner. `compact` keeps
 * the glyph and drops the word, for the tiers where a card is too narrow to hold it; the word is
 * then the flag's title and its text alternative.
 */
export function PendingMark({ op, compact }: { op: PendingMarkOp; compact?: boolean }) {
	const mark = PENDING_MARK[op];
	return (
		<span
			data-testid="pending-mark"
			data-op={op}
			title={mark.spoken}
			className="absolute -top-2.5 left-2 flex items-center gap-1 border border-dashed border-foreground bg-background px-1 font-mono text-ui-3xs uppercase leading-4 tracking-wide text-foreground"
		>
			<span aria-hidden="true">{mark.glyph}</span>
			<span className={cn(compact && "sr-only")}>{mark.word}</span>
		</span>
	);
}

/** The pending changes of several nodes in words: "2 new, 1 edited". Empty when there are none. */
export function pendingSummary(ops: PendingMarkOp[]): string {
	const added = ops.filter((op) => op === "new").length;
	const edited = ops.filter((op) => op === "modified").length;
	return [added > 0 ? `${added} new` : "", edited > 0 ? `${edited} edited` : ""]
		.filter(Boolean)
		.join(", ");
}

/**
 * A validation problem, as a triangle and the problem's own sentence. `compact` keeps the triangle
 * and moves the sentence to its title and text alternative.
 */
export function ProblemMark({ message, compact }: { message: string; compact?: boolean }) {
	return (
		<span
			data-testid="problem-mark"
			title={message}
			className={cn(
				"flex min-w-0 items-center gap-1.5 font-mono text-ui-2xs text-foreground",
				compact && "shrink-0",
			)}
		>
			<TriangleAlert aria-hidden="true" className="h-3 w-3 shrink-0" />
			<span className={cn(compact ? "sr-only" : "truncate")}>
				<span className="sr-only">Problem: </span>
				{message}
			</span>
		</span>
	);
}

/** The facts a card's description is made of. */
export interface CardFacts {
	/** The status word: "Live", "Needs setup". */
	status: string;
	/** The pending change in words, or "" when there is none. */
	pending?: string;
	/** The first validation problem, or "" when the card is complete. */
	problem?: string;
	/** Anything else the card shows that has no other text ("2 drifted"). */
	notes?: readonly string[];
	/** The titles of the cards this one is connected to. */
	connections?: readonly string[];
}

/** A list in words: "a", "a and b", "a, b and c". */
function listInWords(items: readonly string[]): string {
	if (items.length <= 1) return items.join("");
	return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * A card's spoken description: its status, its marks and what it is connected to, in that order.
 * The card's name is not repeated — the focused element already carries it.
 */
export function describeCard(facts: CardFacts): string {
	const connections = facts.connections ?? [];
	const sentences = [
		`Status: ${facts.status}`,
		facts.pending ?? "",
		facts.problem ? `Problem: ${facts.problem.replace(/[.\s]+$/, "")}` : "",
		...(facts.notes ?? []),
		connections.length > 0 ? `Connected to ${listInWords(connections)}` : "Not connected",
	];
	return `${sentences.filter(Boolean).join(". ")}.`;
}

/**
 * The element that holds a card's description. Not drawn; the card's focusable wrapper points at
 * it with `aria-describedby`, so it is announced with the card and not as loose text inside it.
 */
export function CardDescription({ nodeId, facts }: { nodeId: string; facts: CardFacts }) {
	return (
		<span id={cardDescriptionId(nodeId)} className="sr-only" suppressHydrationWarning>
			{describeCard(facts)}
		</span>
	);
}
