"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
	children: ReactNode;
	/** Called when the user dismisses the error (closes the surface). */
	onReset?: () => void;
}

interface State {
	error: Error | null;
}

/**
 * Wraps the Elench conversation so a render error inside the transcript (a bad
 * tool part, a streaming-markdown edge case) shows a small recoverable notice
 * instead of a blank overlay. Keyed by the conversation upstream, so starting a
 * new conversation remounts it and clears any prior error.
 */
export class ElenchErrorBoundary extends Component<Props, State> {
	state: State = { error: null };

	/** React error-boundary hook: capture the error into state to render the fallback. */
	static getDerivedStateFromError(error: Error): State {
		return { error };
	}

	/** Log the error for diagnostics (the fallback stays user-facing). */
	componentDidCatch(error: Error, info: ErrorInfo): void {
		console.error("[elench] conversation render error", error, info.componentStack);
	}

	/** Clear the error and close the surface so the next open starts clean. */
	private reset = (): void => {
		this.setState({ error: null });
		this.props.onReset?.();
	};

	render(): ReactNode {
		if (this.state.error) {
			return (
				<div className="fixed right-4 top-4 z-50 flex max-w-sm flex-col gap-2 border border-border bg-background p-4 shadow-lg">
					<span className="text-sm font-medium text-foreground">
						The assistant hit an error
					</span>
					<span className="text-xs text-muted-foreground">
						Something went wrong rendering the conversation. Close and reopen it to
						continue.
					</span>
					<button
						type="button"
						onClick={this.reset}
						className="self-start border border-border px-3 py-1 text-xs text-foreground transition-colors hover:bg-muted"
					>
						Close
					</button>
				</div>
			);
		}
		return this.props.children;
	}
}
