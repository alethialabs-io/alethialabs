// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

export function SiteFooter() {
	return (
		<footer className="border-t border-border mt-16">
			<div className="mx-auto max-w-3xl px-6 py-8 flex items-center justify-between text-xs text-muted-foreground font-mono uppercase tracking-wider">
				<span>© Alethia Labs OÜ</span>
				<a href="/blog/feed.xml" className="hover:text-foreground transition-colors">
					RSS
				</a>
			</div>
		</footer>
	);
}
