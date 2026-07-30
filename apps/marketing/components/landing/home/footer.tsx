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
    links: ["About Alethia Labs", "Brand", "Blog", "Status", "Contact"],
  },
];

/** Maps known footer labels to real routes; the rest are placeholders. */
function hrefFor(label: string): string {
  if (label === "Pricing") return "/pricing";
  if (label === "Documentation" || label === "CLI reference") return "/docs";
  if (label === "GitHub")
    return "https://github.com/alethialabs-io/alethialabs";
  if (label === "Source & licenses") return "/legal/source";
  if (label === "Brand") return "/brand";
  if (label === "Contact") return "/contact";
  return "#";
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
