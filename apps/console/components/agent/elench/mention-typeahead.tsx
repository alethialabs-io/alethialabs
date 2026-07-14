"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The `@`-mention typeahead for the Lexical composer — Discord-style: type `@`, a scrollable,
// keyboard-navigable menu of the owner's taggable resources opens above the caret; picking one
// drops an atomic mention pill. Options come from the existing `searchMentions` action via the
// debounced `useMentionSearch` hook; the menu is its own scroll container so it never overflows.

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
	LexicalTypeaheadMenuPlugin,
	MenuOption,
	useBasicTypeaheadTriggerMatch,
} from "@lexical/react/LexicalTypeaheadMenuPlugin";
import {
	COMMAND_PRIORITY_NORMAL,
	$createTextNode,
	type TextNode,
} from "lexical";
import {
	Boxes,
	Cpu,
	KeyRound,
	LayoutDashboard,
	Loader2,
	type LucideIcon,
	PlugZap,
	ScrollText,
	Server,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { MentionResult, MentionType } from "@/lib/ai/mentions";
import { cn } from "@repo/ui/utils";
import { $createMentionNode } from "./mention-node";
import { useMentionSearch } from "./use-mentions";

const TYPE_ICON: Record<MentionType, LucideIcon> = {
	project: Boxes,
	cluster: Server,
	connector: PlugZap,
	job: ScrollText,
	runner: Cpu,
	identity: KeyRound,
	artifact: LayoutDashboard,
};

/** A typeahead option wrapping one resolved mention candidate. */
class MentionMenuOption extends MenuOption {
	constructor(public readonly result: MentionResult) {
		super(`${result.type}:${result.id}`);
	}
}

/**
 * Registers the `@` typeahead on the enclosing Lexical editor. Renders nothing itself except the
 * floating menu (via the plugin's `menuRenderFn`).
 */
export function MentionTypeaheadPlugin() {
	const [editor] = useLexicalComposerContext();
	// `null` query = menu closed. Empty string = `@` with no text yet (show everything).
	const [query, setQuery] = useState<string | null>(null);
	const { results, loading } = useMentionSearch(
		query === null ? null : { start: 0, query },
	);

	const options = useMemo(
		() => results.map((r) => new MentionMenuOption(r)),
		[results],
	);

	// `@` preceded by whitespace/start; allow an empty query so the menu opens on `@` alone.
	const triggerFn = useBasicTypeaheadTriggerMatch("@", { minLength: 0 });

	const onSelect = useCallback(
		(
			option: MentionMenuOption,
			nodeToReplace: TextNode | null,
			closeMenu: () => void,
		) => {
			editor.update(() => {
				const { id, type, label } = option.result;
				const pill = $createMentionNode(`@${label}`, id, type);
				if (nodeToReplace) nodeToReplace.replace(pill);
				// Trailing space + caret after it (Discord behaviour).
				const space = $createTextNode(" ");
				pill.insertAfter(space);
				space.select(1, 1);
				closeMenu();
			});
		},
		[editor],
	);

	return (
		<LexicalTypeaheadMenuPlugin<MentionMenuOption>
			options={options}
			onQueryChange={setQuery}
			onSelectOption={onSelect}
			triggerFn={triggerFn}
			commandPriority={COMMAND_PRIORITY_NORMAL}
			menuRenderFn={(anchorElementRef, { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex }) => {
				if (!anchorElementRef.current) return null;
				return createPortal(
					<div className="absolute bottom-2 left-0 z-50 w-[320px] max-w-[80vw] border border-border bg-popover shadow-md">
						<div className="vx-eyebrow flex items-center gap-1.5 border-b border-border px-2.5 py-1.5 text-[9px]">
							Tag a resource
							{loading && <Loader2 className="h-3 w-3 animate-spin" />}
						</div>
						<ul className="max-h-64 overflow-y-auto py-1">
							{options.length === 0 && !loading && (
								<li className="px-3 py-2 text-xs text-muted-foreground">
									No matching resources.
								</li>
							)}
							{options.map((option, i) => {
								const Icon = TYPE_ICON[option.result.type];
								return (
									<li key={option.key}>
										<button
											type="button"
											ref={(el) => option.setRefElement(el)}
											onMouseEnter={() => setHighlightedIndex(i)}
											onClick={() => selectOptionAndCleanUp(option)}
											className={cn(
												"flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors",
												i === selectedIndex ? "bg-muted" : "hover:bg-muted",
											)}
										>
											<Icon className="h-4 w-4 flex-none text-muted-foreground" />
											<span className="min-w-0 flex-1">
												<span className="block truncate text-[13px] text-foreground">
													{option.result.label}
												</span>
												<span className="block truncate font-mono text-[10px] text-muted-foreground">
													{option.result.type} · {option.result.sublabel}
												</span>
											</span>
										</button>
									</li>
								);
							})}
						</ul>
					</div>,
					anchorElementRef.current,
				);
			}}
		/>
	);
}
