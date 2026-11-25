// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The known-agent catalogue (AGT-L2, gap G15): which MCP apps Alethia recognises, how each is named
// and described on the connected-agents board and the consent screen, which brand mark draws it, and
// where its setup page is. An MCP client identifies itself by the URL of its Client ID Metadata
// Document (CIMD), so an entry is matched on that URL's HOST. A client that matches no entry is still
// allowed to connect; it is shown by the name it gave itself (`oauth_client.name`), its own icon if it
// has one, and a neutral glyph — never a letter — and the consent screen marks it unverified.
//
// The mark slugs are simple-icons slugs (the source components/alerts/channel-icon.tsx draws from),
// except `openai`, which is drawn from OpenAI's own file once it ships under
// packages/assets/static/icons/openai/. The UI owns the drawing; this file only names the mark.
//
// Plain data, no server imports, so a client component can read it too.

/** One known agent app. */
export interface AgentApp {
	/** Stable key. */
	slug: string;
	/** The app's own name, as its owner writes it. */
	name: string;
	/** One line saying what the app is. */
	description: string;
	/**
	 * CIMD client-id hosts that identify this app. Matched exactly, or as a parent domain, so each
	 * must be a host ONLY the app's owner can publish under — never a shared host where anyone can
	 * serve a file (a gist host, a pages host), or any app could borrow the name. Confirm each host
	 * against the client's published metadata document when its setup page is tested.
	 */
	hosts: readonly string[];
	/** The brand mark to draw. */
	mark: string;
	/** The setup page under the docs site, e.g. `/docs/agents/claude-code`. */
	docsPath: string;
}

/**
 * The catalogue, in the order the connected-agents board lists apps nobody has connected. The docs
 * paths are the existing agent setup pages (apps/docs/content/docs/agents/).
 */
export const AGENT_APPS: readonly AgentApp[] = [
	{
		slug: "claude-code",
		name: "Claude Code",
		description: "Anthropic's coding agent, in your terminal and editor.",
		hosts: ["claude.ai/code", "code.claude.com"],
		mark: "claudecode",
		docsPath: "/docs/agents/claude-code",
	},
	{
		slug: "claude",
		name: "Claude",
		description: "Claude on the web and in the desktop app, as a custom connector.",
		hosts: ["claude.ai", "claude.com"],
		mark: "claude",
		docsPath: "/docs/agents/claude",
	},
	{
		slug: "cursor",
		name: "Cursor",
		description: "The AI code editor's agent.",
		hosts: ["cursor.com", "cursor.sh"],
		mark: "cursor",
		docsPath: "/docs/agents/cursor",
	},
	{
		slug: "github-copilot",
		name: "GitHub Copilot",
		description: "Copilot's agent mode in VS Code.",
		hosts: ["vscode.dev", "code.visualstudio.com"],
		mark: "githubcopilot",
		docsPath: "/docs/agents/vs-code",
	},
	{
		slug: "codex",
		name: "OpenAI Codex",
		description: "OpenAI's coding agent, in the Codex CLI.",
		hosts: ["openai.com", "chatgpt.com"],
		mark: "openai",
		docsPath: "/docs/agents/codex",
	},
];

/**
 * The host-and-path key of a CIMD client id, lower-cased, or null when it is not an https URL. The
 * path is kept so an entry can name a path under a shared host (`claude.ai/code`).
 */
function clientKey(clientId: string): { host: string; path: string } | null {
	try {
		const url = new URL(clientId);
		if (url.protocol !== "https:") return null;
		return { host: url.hostname.toLowerCase(), path: url.pathname.toLowerCase() };
	} catch {
		return null;
	}
}

/** True when `pattern` (a host, or `host/path-prefix`) matches the client's host and path. */
function matches(pattern: string, key: { host: string; path: string }): boolean {
	const [host, ...rest] = pattern.split("/");
	const prefix = rest.length ? `/${rest.join("/")}` : "";
	const hostMatches = key.host === host || key.host.endsWith(`.${host}`);
	if (!hostMatches) return false;
	return prefix === "" || key.path === prefix || key.path.startsWith(`${prefix}/`);
}

/**
 * The catalogue entry for an OAuth client id, or null for an app Alethia does not recognise. A
 * client id that is not an https CIMD URL never matches. The most specific pattern wins, so
 * `claude.ai/code/…` is Claude Code while the rest of `claude.ai` is Claude.
 */
export function agentAppFor(clientId: string): AgentApp | null {
	const key = clientKey(clientId);
	if (!key) return null;
	let best: { app: AgentApp; weight: number } | null = null;
	for (const app of AGENT_APPS) {
		for (const pattern of app.hosts) {
			if (!matches(pattern, key)) continue;
			const weight = pattern.length;
			if (!best || weight > best.weight) best = { app, weight };
		}
	}
	return best?.app ?? null;
}

/** How a connected client is shown: the catalogue's entry, or the client's own name and icon. */
export interface AgentAppIdentity {
	/** The catalogue entry, when the client is a known app. */
	app: AgentApp | null;
	/** The name to show. */
	name: string;
	/** The client's own icon URL, for an app the catalogue does not know. */
	icon: string | null;
	/** The host the client identifies itself by, shown as "Verified by …" or under an unknown name. */
	host: string | null;
}

/** The identity to show for an OAuth client, from its id and the name and icon it registered. */
export function agentAppIdentity(client: { clientId: string; name: string | null; icon: string | null }): AgentAppIdentity {
	const app = agentAppFor(client.clientId);
	const host = clientKey(client.clientId)?.host ?? null;
	return {
		app,
		name: app?.name ?? client.name ?? host ?? "Unnamed app",
		icon: app ? null : client.icon,
		host,
	};
}
