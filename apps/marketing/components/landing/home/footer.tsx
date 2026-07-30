// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { LEGAL_ENTITY } from "@repo/brand/legal";
import Link from "next/link";
import { disp, eyebrow, Lockup, mono, Wrap } from "./primitives";

interface FooterCol {
  title: string;
  links: string[];
}

const COLUMNS: FooterCol[] = [
  {
    title: "Product",
    links: [
      "Console",
      "Project designer",
      "alethia CLI",
      "Runners",
      "Jobs",
      "Alerts",
    ],
  },
  { title: "Intelligence", links: ["AI agent", "Repo scanner", "MCP server"] },
  {
    title: "Enterprise",
    links: [
      "Organizations",
      "SSO — OIDC & SAML",
      "Roles & RBAC",
      "Audit log",
      "Pricing",
    ],
  },
  {
    title: "Resources",
    links: [
      "Documentation",
      "Quickstart",
      "CLI reference",
      "Architecture",
      "GitHub",
      "Source & licenses",
      "Changelog",
    ],
  },
  {
    title: "Company",
    links: ["Brand", "Blog", "Status", "Contact"],
  },
];

/** Maps every footer label to a real first-party page or maintained external destination. */
function hrefFor(label: string): string {
  if (label === "Console") return "/docs/console";
  if (label === "Project designer") return "/docs/console/design-project";
  if (label === "alethia CLI") return "/docs/cli";
  if (label === "Runners") return "/docs/runner";
  if (label === "Jobs") return "/docs/console/jobs";
  if (label === "Alerts") return "/docs/console/alerts";
  if (label === "AI agent") return "/docs/console/assistant";
  if (label === "Repo scanner") return "/docs/elench/architecture";
  if (label === "MCP server") return "/docs/console/assistant/mcp";
  if (label === "Organizations") return "/docs/access-control/organizations";
  if (label === "SSO — OIDC & SAML") return "/docs/access-control/sso";
  if (label === "Roles & RBAC")
    return "/docs/access-control/roles-and-permissions";
  if (label === "Audit log") return "/docs/access-control/activity-log";
  if (label === "Pricing") return "/pricing";
  if (label === "Documentation") return "/docs";
  if (label === "Quickstart") return "/docs/console/getting-started";
  if (label === "CLI reference") return "/docs/cli/commands";
  if (label === "Architecture") return "/docs/elench/architecture";
  if (label === "GitHub")
    return "https://github.com/alethialabs-io/alethialabs";
  if (label === "Source & licenses") return "/legal/source";
  if (label === "Changelog")
    return "https://github.com/alethialabs-io/alethialabs/releases";
  if (label === "Brand") return "/brand";
  if (label === "Blog") return "/blog";
  if (label === "Status") return "https://status.alethialabs.io";
  if (label === "Contact") return "/contact/sales";
  throw new Error(`Missing footer route for "${label}"`);
}

/** Public site footer — brand, link columns, and open-core attribution. */
export function Footer() {
  return (
    <footer
      style={{
        borderTop: "1px solid var(--border)",
        padding: "60px 0 34px",
        background: "var(--surface-sunken)",
      }}
    >
      <Wrap>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1.4fr repeat(5,1fr)",
            gap: 28,
            marginBottom: 48,
          }}
          className="ah-foot-grid"
        >
          <div>
            <Lockup size={22} />
            <p
              style={{
                fontSize: 12.5,
                color: "var(--text-tertiary)",
                lineHeight: 1.65,
                maxWidth: 240,
                margin: "16px 0 0",
              }}
            >
              One control plane for multi-cloud Kubernetes. Configure visually,
              deploy with zero stored credentials, reconcile with GitOps.
            </p>
          </div>
          {COLUMNS.map((col) => (
            <div key={col.title}>
              <p style={{ ...eyebrow, fontSize: 10, marginBottom: 15 }}>
                {col.title}
              </p>
              <ul
                style={{
                  listStyle: "none",
                  padding: 0,
                  margin: 0,
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                }}
              >
                {col.links.map((l) => (
                  <li key={l}>
                    <Link
                      href={hrefFor(l)}
                      style={{
                        fontSize: 13,
                        color: "var(--text-tertiary)",
                        textDecoration: "none",
                        ...disp,
                        fontWeight: 400,
                      }}
                    >
                      {l}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div style={{ height: 1, background: "var(--border)" }} />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            paddingTop: 24,
            flexWrap: "wrap",
            gap: 12,
          }}
        >
          <p style={{ ...eyebrow, fontSize: 10, margin: 0 }}>
            © 2026 {LEGAL_ENTITY.tradingName} · AGPL-3.0 open core
          </p>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 14,
              flexWrap: "wrap",
              justifyContent: "flex-end",
            }}
          >
            <Link href="/terms" style={{ ...eyebrow, fontSize: 9 }}>
              Terms
            </Link>
            <Link href="/privacy" style={{ ...eyebrow, fontSize: 9 }}>
              Privacy
            </Link>
            <Link href="/cookies" style={{ ...eyebrow, fontSize: 9 }}>
              Cookies
            </Link>
            <Link href="/legal/dpa" style={{ ...eyebrow, fontSize: 9 }}>
              DPA
            </Link>
            <p style={{ ...eyebrow, fontSize: 10, margin: 0, ...mono }}>
              aletheia · truth, brought into focus
            </p>
          </div>
        </div>
      </Wrap>
    </footer>
  );
}
