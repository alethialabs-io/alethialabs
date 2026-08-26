// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { Button } from "@repo/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@repo/ui/sheet";
import { ProviderIcon } from "@repo/ui/provider-icon";
import { AlethiaLockup } from "../lockup";
import {
  disp,
  Icon,
  type IconKey,
  mono,
  Wrap,
} from "./primitives";

const GITHUB_URL = "https://github.com/alethialabs-io/alethialabs";

interface MenuLink {
  ic: IconKey;
  name: string;
  desc: string;
  href: string;
  badge?: boolean;
  external?: boolean;
}
/**
 * The products. There are three, and this list holds three.
 *
 * It used to hold twelve across four groups — Project designer, Runners, Jobs,
 * Alerts, AI agent, Repo scanner, MCP server, Organizations, SSO, RBAC. Those are
 * FEATURES of the three products below, not products, and listing them here made
 * the menu a feature dump that told a visitor nothing about what Alethia sells.
 * Governance already has its own nav item (/enterprise); everything else is one
 * level down in the docs where it belongs.
 */
const PRODUCT_MENU: MenuLink[] = [
  {
    ic: "grid",
    name: "Console",
    desc: "The control plane — configure infrastructure visually, watch it apply",
    href: "/docs/console",
  },
  {
    ic: "terminal",
    name: "alethia CLI",
    desc: "Plan, apply, and operate from your shell",
    href: "/docs/cli",
  },
  {
    ic: "shield",
    name: "Elench",
    desc: "The gate between plan and apply — every apply leaves a signed receipt",
    href: "/docs/elench",
  },
];

const RESOURCE_MENU: MenuLink[] = [
  {
    ic: "book",
    name: "Docs",
    desc: "Guides, concepts, and the full CLI reference",
    href: "/docs",
    badge: true,
  },
  {
    ic: "layers",
    name: "Open source",
    desc: "AGPL core — self-host on any cloud",
    href: "/open-source",
  },
  {
    ic: "pen",
    name: "Blog",
    desc: "Engineering notes and product updates",
    href: "/blog",
  },
  {
    ic: "list",
    name: "Changelog",
    desc: "What shipped, every week",
    href: `${GITHUB_URL}/releases`,
    external: true,
  },
];

/** Formats a raw star count compactly (2400 → "2.4k", 950 → "950"). */
function formatStars(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return (k >= 10 ? Math.round(k) : Math.round(k * 10) / 10) + "k";
}

/** Single mega-menu entry row (icon tile + name + description). */
/** One row in a mega-menu. Hover is CSS, not React state: the previous version
 * tracked it with `useState` per item, so moving the pointer across the Product
 * menu re-rendered a component twelve times for a background colour. */
function MenuItem({ ic, name, desc, badge, href, external }: MenuLink) {
  return (
    <Link
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined}
      className="vx-clamp vx-clamp--tight hover:bg-[var(--surface-muted)]"
      style={{
        display: "flex",
        gap: 12,
        padding: "10px 11px",
        borderRadius: "var(--radius-md)",
        background: "transparent",
        textDecoration: "none",
        transition: "background var(--dur-1) var(--ease)",
      }}
    >
      <span
        style={{
          display: "grid",
          placeItems: "center",
          width: 34,
          height: 34,
          flexShrink: 0,
          borderRadius: "var(--radius-sm)",
          border: "1px solid var(--border)",
          background: "var(--surface-sunken)",
          color: "var(--text-primary)",
        }}
      >
        <Icon k={ic} size={16} />
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              fontSize: 13.5,
              fontWeight: 500,
              color: "var(--text-primary)",
              ...disp,
            }}
          >
            {name}
          </span>
          {badge && (
            <span
              style={{
                ...mono,
                fontSize: 8.5,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                color: "var(--text-tertiary)",
                border: "1px solid var(--border-strong)",
                borderRadius: "var(--radius-xs)",
                padding: "1px 5px",
              }}
            >
              Start here
            </span>
          )}
        </div>
        <p
          style={{
            fontSize: 11.5,
            color: "var(--text-tertiary)",
            margin: "3px 0 0",
            lineHeight: 1.4,
          }}
        >
          {desc}
        </p>
      </div>
    </Link>
  );
}

/** Hover-open dropdown wrapper for a nav item. */
function NavMenu({
  label,
  id,
  open,
  setOpen,
  width,
  children,
}: {
  label: string;
  id: string;
  open: string | null;
  setOpen: (v: string | null) => void;
  width: number;
  children: React.ReactNode;
}) {
  const active = open === id;
  return (
    <div
      onMouseEnter={() => setOpen(id)}
      onMouseLeave={() => setOpen(null)}
      style={{ position: "relative" }}
    >
      <button
        type="button"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          padding: "7px 12px",
          fontSize: 13.5,
          color: active ? "var(--text-primary)" : "var(--text-tertiary)",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          borderRadius: "var(--radius-sm)",
          fontFamily: "inherit",
        }}
      >
        {label}
        <span
          style={{
            display: "flex",
            transform: active ? "rotate(180deg)" : "none",
            transition: "transform .15s",
            opacity: 0.7,
          }}
        >
          <Icon k="chev" size={13} sw={2} />
        </span>
      </button>
      {active && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            width,
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-lg)",
            background: "var(--surface)",
            boxShadow: "var(--shadow-lg)",
            padding: 14,
            zIndex: 60,
            marginTop: 1,
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/** GitHub link with an optional live star count. */
function GitHubLink({ stars }: { stars?: number | null }) {
  return (
    <a
      href={GITHUB_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="ah-hide-sm"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontSize: 13,
        color: "var(--text-tertiary)",
        textDecoration: "none",
      }}
    >
      <ProviderIcon provider="github" size={16} />
      {stars != null && (
        <span style={{ ...mono, fontSize: 12 }}>{formatStars(stars)}</span>
      )}
    </a>
  );
}

/** A top-level nav link. `aria-current="page"` is the accessible signal that this
 * is the page you are on, and the clamp reads the same attribute — so the visual
 * held state and the announced one can never disagree. */
function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const current = pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      aria-current={current ? "page" : undefined}
      className="vx-clamp vx-clamp--tight"
      style={{
        ...NAV_LINK_STYLE,
        color: current ? "var(--text-primary)" : NAV_LINK_STYLE.color,
      }}
    >
      {children}
    </Link>
  );
}

const NAV_LINK_STYLE: React.CSSProperties = {
  padding: "7px 12px",
  fontSize: 13.5,
  color: "var(--text-tertiary)",
  borderRadius: "var(--radius-sm)",
  textDecoration: "none",
};

type BillingPlan = "community" | "team" | "enterprise";

interface NavContext {
  status: "anon" | "authed";
  plan?: BillingPlan;
  /** Console path to the active org (`/{slug}`). */
  dashboardPath?: string;
  /** Console path to the active org's billing settings (the upgrade surface). */
  upgradePath?: string;
}

/**
 * Reads the viewer's auth + plan state from the console's `/api/nav-context`. The
 * marketing zone shares the prod origin with the console, so this same-origin fetch
 * carries the Better Auth cookie. Defaults to `anon` (the always-redirected landing
 * page is the common case) and only flips to `authed` once the probe resolves — so
 * signed-out visitors never flash. Stays `anon` if the probe is unreachable (e.g. a
 * bare marketing dev server with no console behind it).
 */
function useNavContext(): NavContext {
  const [ctx, setCtx] = useState<NavContext>({ status: "anon" });
  useEffect(() => {
    let active = true;
    fetch("/api/nav-context", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!active || !data?.authenticated) return;
        setCtx({
          status: "authed",
          plan: data.plan,
          dashboardPath: data.dashboardPath,
          upgradePath: data.upgradePath,
        });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  return ctx;
}

/** Public site header — brand lockup, Product/Resources menus, Enterprise & Pricing links, GitHub, and CTAs. */
export function Header({
  stars,
  homeHref = "/",
}: {
  stars?: number | null;
  homeHref?: "/" | "/home";
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [mobile, setMobile] = useState(false);
  const nav = useNavContext();
  return (
    <header
      style={{
        position: "sticky",
        top: 0,
        zIndex: 50,
        // The fixed `.vx-frame` (z-60) paints over this header (z-50), so the
        // visible band starts at `--frame-inset`, not at 0. Without this the 62px
        // row centres at y=31 — 20.5px above the frame line, 31.5px below the
        // bottom rule — and the nav reads as sitting too high. Padding rather
        // than `top: 10px`: the background and backdrop-filter must still cover
        // the whole band, and scrolled page content must never show through the
        // strip outside the frame.
        paddingTop: "calc(var(--frame-inset) + 1px)",
        borderBottom: "1px solid var(--border)",
        background: "color-mix(in oklch, var(--background) 80%, transparent)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
      }}
    >
      <Wrap
        style={{
          height: 62,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <Link href={homeHref} style={{ textDecoration: "none" }}>
          <AlethiaLockup size={24} />
        </Link>

        <nav
          style={{ display: "flex", alignItems: "center", gap: 2 }}
          className="ah-navmenu"
        >
          <NavMenu
            label="Product"
            id="product"
            open={open}
            setOpen={setOpen}
            width={360}
          >
            {PRODUCT_MENU.map((it) => (
              <MenuItem key={it.name} {...it} />
            ))}
            <div
              style={{
                borderTop: "1px solid var(--border-faint)",
                marginTop: 8,
                padding: "12px 11px 4px",
              }}
            >
              <a
                href="/docs/console/getting-started"
                className="vx-clamp vx-clamp--tight"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 12.5,
                  color: "var(--text-primary)",
                  whiteSpace: "nowrap",
                  textDecoration: "none",
                }}
              >
                Getting started <Icon k="arrow" size={13} />
              </a>
            </div>
          </NavMenu>

          <NavMenu
            label="Resources"
            id="resources"
            open={open}
            setOpen={setOpen}
            width={320}
          >
            {RESOURCE_MENU.map((it) => (
              <MenuItem key={it.name} {...it} />
            ))}
          </NavMenu>

          <NavLink href="/enterprise">Enterprise</NavLink>
          <NavLink href="/pricing">Pricing</NavLink>
        </nav>

        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <GitHubLink stars={stars} />
          {nav.status === "authed" ? (
            <>
              {nav.plan === "community" && (
                <Link
                  href={nav.upgradePath ?? "/dashboard/settings/billing"}
                  className="ah-hide-sm"
                >
                  <Button variant="outline" size="sm">
                    Upgrade to Pro
                  </Button>
                </Link>
              )}
              {nav.plan === "team" && (
                <Link href="/contact/enterprise" className="ah-hide-sm">
                  <Button variant="outline" size="sm">
                    Talk to sales
                  </Button>
                </Link>
              )}
              <Link href={nav.dashboardPath ?? "/dashboard"}>
                <Button size="sm">
                  Dashboard <Icon k="arrow" size={14} />
                </Button>
              </Link>
            </>
          ) : (
            <>
              <Link href="/contact/sales" className="ah-hide-sm">
                <Button variant="outline" size="sm">
                  Get a demo
                </Button>
              </Link>
              <Link href="/login" className="ah-hide-sm">
                <Button variant="ghost" size="sm">
                  Login
                </Button>
              </Link>
              <Link href="/signup">
                <Button size="sm">
                  Sign up <Icon k="arrow" size={14} />
                </Button>
              </Link>
            </>
          )}

          {/* mobile */}
          <Sheet open={mobile} onOpenChange={setMobile}>
            <SheetTrigger
              render={
                <Button variant="ghost" size="icon-sm" className="hidden max-[900px]:inline-flex">
                  <Menu className="h-4 w-4" />
                </Button>
              }
            />
            <SheetContent side="right" className="w-72 overflow-y-auto">
              <nav className="mt-8 flex flex-col gap-1">
                <p className="vx-eyebrow px-3 pb-1 pt-2">Product</p>
                {PRODUCT_MENU.map((it) => (
                  <Link
                    key={it.name}
                    href={it.href}
                    onClick={() => setMobile(false)}
                    className="rounded-md px-3 py-2 text-sm text-text-secondary hover:bg-surface-muted hover:text-text-primary"
                  >
                    {it.name}
                  </Link>
                ))}
                <p className="vx-eyebrow px-3 pb-1 pt-3">Resources</p>
                {RESOURCE_MENU.map((it) => (
                  <Link
                    key={it.name}
                    href={it.href}
                    target={it.external ? "_blank" : undefined}
                    rel={it.external ? "noreferrer" : undefined}
                    onClick={() => setMobile(false)}
                    className="rounded-md px-3 py-2 text-sm text-text-secondary hover:bg-surface-muted hover:text-text-primary"
                  >
                    {it.name}
                  </Link>
                ))}
                <Link
                  href="/enterprise"
                  onClick={() => setMobile(false)}
                  className="rounded-md px-3 py-2 text-sm text-text-secondary hover:bg-surface-muted hover:text-text-primary"
                >
                  Enterprise
                </Link>
                <Link
                  href="/pricing"
                  onClick={() => setMobile(false)}
                  className="rounded-md px-3 py-2 text-sm text-text-secondary hover:bg-surface-muted hover:text-text-primary"
                >
                  Pricing
                </Link>
                <div className="mt-3 flex flex-col gap-2 border-t border-border-faint pt-4">
                  {nav.status === "authed" ? (
                    <>
                      {nav.plan === "community" && (
                        <Link
                          href={nav.upgradePath ?? "/dashboard/settings/billing"}
                          onClick={() => setMobile(false)}
                        >
                          <Button
                            variant="outline"
                            size="sm"
                            className="w-full"
                          >
                            Upgrade to Pro
                          </Button>
                        </Link>
                      )}
                      {nav.plan === "team" && (
                        <Link
                          href="/contact/enterprise"
                          onClick={() => setMobile(false)}
                        >
                          <Button
                            variant="outline"
                            size="sm"
                            className="w-full"
                          >
                            Talk to sales
                          </Button>
                        </Link>
                      )}
                      <Link
                        href={nav.dashboardPath ?? "/dashboard"}
                        onClick={() => setMobile(false)}
                      >
                        <Button size="sm" className="w-full">
                          Dashboard
                        </Button>
                      </Link>
                    </>
                  ) : (
                    <>
                      <Link
                        href="/contact/sales"
                        onClick={() => setMobile(false)}
                      >
                        <Button variant="outline" size="sm" className="w-full">
                          Get a demo
                        </Button>
                      </Link>
                      <Link href="/login" onClick={() => setMobile(false)}>
                        <Button variant="ghost" size="sm" className="w-full">
                          Login
                        </Button>
                      </Link>
                      <Link href="/signup" onClick={() => setMobile(false)}>
                        <Button size="sm" className="w-full">
                          Sign up
                        </Button>
                      </Link>
                    </>
                  )}
                </div>
              </nav>
            </SheetContent>
          </Sheet>
        </div>
      </Wrap>
    </header>
  );
}
