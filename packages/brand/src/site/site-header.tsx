// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { CSSProperties, FocusEvent, KeyboardEvent, ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowUpRight, Menu } from "lucide-react";
import { Button } from "@repo/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@repo/ui/sheet";
import { AlethiaLockup } from "../lockup";
import { Icon, Wrap } from "./primitives";

const GITHUB_URL = "https://github.com/alethialabs-io/alethialabs";

interface MenuLink {
  name: string;
  href: string;
  external?: boolean;
}

/*
 * The header's whole information architecture, as data. Desktop and the mobile
 * sheet both render from these lists, so the two can never disagree about what
 * the site has in it.
 *
 * There is no Product menu any more. It held three doc links (Console, CLI,
 * Elench) that the Docs landing and the home page already carry, and a menu
 * that only re-links the next click is a detour, not navigation.
 */
const LEFT_LINKS: MenuLink[] = [{ name: "Docs", href: "/docs" }];

const RESOURCE_MENU: MenuLink[] = [
  { name: "Blog", href: "/blog" },
  { name: "Changelog", href: `${GITHUB_URL}/releases`, external: true },
  { name: "Open source", href: "/open-source" },
];

const LEFT_TRAILING_LINKS: MenuLink[] = [
  { name: "Pricing", href: "/pricing" },
  { name: "Enterprise", href: "/enterprise" },
];

const COMPANY_MENU: MenuLink[] = [
  { name: "About", href: "/about" },
  { name: "Services", href: "/services" },
  { name: "Security", href: "/security" },
  { name: "Legal", href: "/legal" },
];

const CONTACT_LINK: MenuLink = { name: "Contact", href: "/contact" };

/** The order the mobile sheet lists top-level links in, before its two groups. */
const MOBILE_TOP_LINKS: MenuLink[] = [...LEFT_LINKS, ...LEFT_TRAILING_LINKS];

const NAV_LINK_STYLE: CSSProperties = {
  padding: "7px 12px",
  fontSize: 13.5,
  color: "var(--text-tertiary)",
  borderRadius: "var(--radius-sm)",
  textDecoration: "none",
};

/** The small "opens elsewhere" arrow, plus words for a screen reader. */
function ExternalMark() {
  return (
    <>
      <ArrowUpRight aria-hidden size={12} strokeWidth={1.8} style={{ opacity: 0.7 }} />
      <span className="sr-only"> (opens in a new tab)</span>
    </>
  );
}

/** One text-only row inside a dropdown: the name, and an arrow if it leaves the site. */
function MenuRow({ name, href, external }: MenuLink) {
  return (
    <Link
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined}
      className="text-text-secondary hover:text-text-primary focus-visible:text-text-primary"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "7px 10px",
        fontSize: 13.5,
        borderRadius: "var(--radius-sm)",
        textDecoration: "none",
        whiteSpace: "nowrap",
        transition: "color var(--dur-1) var(--ease)",
      }}
    >
      {name}
      {external && <ExternalMark />}
    </Link>
  );
}

/**
 * A nav item that opens a small text-only dropdown.
 *
 * It opens on hover, on focus (tabbing onto the trigger opens it, so the rows are
 * the next Tab stops) and on click, and closes on pointer leave, on focus leaving
 * the whole item, and on Escape — which also hands focus back to the trigger. The
 * previous menu opened on hover only, so a keyboard could not reach its links.
 */
function NavMenu({
  label,
  id,
  open,
  setOpen,
  align = "left",
  items,
}: {
  label: string;
  id: string;
  open: string | null;
  setOpen: (v: string | null) => void;
  align?: "left" | "right";
  items: MenuLink[];
}) {
  const active = open === id;
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);

  /** Closes the menu once focus moves to something outside it. */
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget)) setOpen(null);
  };

  /** Escape closes the menu and returns focus to its trigger. */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape" || !active) return;
    e.stopPropagation();
    setOpen(null);
    triggerRef.current?.focus();
  };

  return (
    <div
      onMouseEnter={() => setOpen(id)}
      onMouseLeave={() => setOpen(null)}
      onFocus={() => setOpen(id)}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      style={{ position: "relative" }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={active}
        aria-controls={panelId}
        // Click OPENS rather than toggles: focus already opened it a moment
        // earlier, so a toggle would close the menu on the very click that
        // was meant to open it.
        onClick={() => setOpen(id)}
        className="vx-clamp vx-clamp--tight"
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
      <div
        id={panelId}
        hidden={!active}
        style={{
          position: "absolute",
          top: "100%",
          // The right-hand menu hangs from its right edge so it never runs off the page.
          left: align === "left" ? 0 : undefined,
          right: align === "right" ? 0 : undefined,
          minWidth: 180,
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          background: "var(--surface)",
          boxShadow: "var(--shadow-lg)",
          padding: 6,
          // An overlay opened FROM the header, so it takes the overlay rung — not the
          // frame's. At the old literal 60 it TIED with .vx-frame and won only on DOM
          // order; now it outranks the whole chrome by number.
          zIndex: "var(--z-overlay)",
          marginTop: 1,
        }}
      >
        {items.map((it) => (
          <MenuRow key={it.name} {...it} />
        ))}
      </div>
    </div>
  );
}

/** A top-level nav link. `aria-current="page"` is the accessible signal that this
 * is the page you are on, and the clamp reads the same attribute — so the visual
 * held state and the announced one can never disagree. */
function NavLink({ href, children }: { href: string; children: ReactNode }) {
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

interface NavContext {
  status: "anon" | "authed";
  /** Console path to the active org (`/{slug}`). */
  dashboardPath?: string;
}

/** Narrows the untyped `/api/nav-context` body to the one thing the header reads. */
function readNavContext(data: unknown): NavContext {
  if (typeof data !== "object" || data === null) return { status: "anon" };
  if (!("authenticated" in data) || !data.authenticated) return { status: "anon" };
  const dashboardPath =
    "dashboardPath" in data && typeof data.dashboardPath === "string"
      ? data.dashboardPath
      : undefined;
  return { status: "authed", dashboardPath };
}

/**
 * Reads the viewer's auth state from the console's `/api/nav-context`. The
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
      .then((data: unknown) => {
        if (!active) return;
        const next = readNavContext(data);
        if (next.status === "authed") setCtx(next);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  return ctx;
}

/** The one call to action: "Try Alethia" for a visitor, "Dashboard" once signed in. */
function primaryCta(nav: NavContext): { label: string; href: string } {
  return nav.status === "authed"
    ? { label: "Dashboard", href: nav.dashboardPath ?? "/dashboard" }
    : { label: "Try Alethia", href: "/signup" };
}

const SHEET_LINK_CLASS =
  "flex items-center gap-1.5 rounded-md px-3 py-2 text-sm text-text-secondary hover:bg-surface-muted hover:text-text-primary";

/** A link row in the mobile sheet; closes the sheet when followed. */
function SheetLink({ item, onNavigate }: { item: MenuLink; onNavigate: () => void }) {
  return (
    <Link
      href={item.href}
      target={item.external ? "_blank" : undefined}
      rel={item.external ? "noreferrer" : undefined}
      onClick={onNavigate}
      className={SHEET_LINK_CLASS}
    >
      {item.name}
      {item.external && <ExternalMark />}
    </Link>
  );
}

/**
 * Public site header: a three-column grid with the lockup centred.
 *
 * Desktop (≥ 900px): Docs · Resources ▾ · Pricing · Enterprise on the left,
 * Company ▾ · Contact · the CTA on the right. Below 900px: the menu button on the
 * left, the lockup in the centre, and the CTA on the right — always visible, so
 * the one thing the header asks you to do never hides behind the menu.
 */
export function Header({ homeHref = "/" }: { homeHref?: "/" | "/home" }) {
  const [open, setOpen] = useState<string | null>(null);
  const [mobile, setMobile] = useState(false);
  const nav = useNavContext();
  const cta = primaryCta(nav);
  const closeSheet = () => setMobile(false);

  return (
    <header
      style={{
        position: "sticky",
        top: 0,
        zIndex: "var(--z-header)",
        // The fixed `.vx-frame` still paints over this header — the layer scale in
        // tokens.css keeps that order deliberately (--z-frame above --z-header) — so the
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
          display: "grid",
          // `minmax(0, 1fr)` rather than `1fr`: a bare `1fr` has an `auto` minimum,
          // so a side column wider than its share would push the lockup off centre.
          gridTemplateColumns: "minmax(0, 1fr) auto minmax(0, 1fr)",
          alignItems: "center",
          columnGap: 12,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-start" }}>
          <Sheet open={mobile} onOpenChange={setMobile}>
            <SheetTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Open menu"
                  className="ah-nav-mobile"
                >
                  <Menu className="h-4 w-4" />
                </Button>
              }
            />
            <SheetContent side="left" className="w-72 overflow-y-auto">
              <SheetTitle className="sr-only">Site menu</SheetTitle>
              <nav aria-label="Site" className="mt-8 flex flex-col gap-1">
                {MOBILE_TOP_LINKS.map((it) => (
                  <SheetLink key={it.name} item={it} onNavigate={closeSheet} />
                ))}
                <p className="vx-eyebrow px-3 pb-1 pt-3">Resources</p>
                {RESOURCE_MENU.map((it) => (
                  <SheetLink key={it.name} item={it} onNavigate={closeSheet} />
                ))}
                <p className="vx-eyebrow px-3 pb-1 pt-3">Company</p>
                {COMPANY_MENU.map((it) => (
                  <SheetLink key={it.name} item={it} onNavigate={closeSheet} />
                ))}
                <div className="mt-3 border-t border-border-faint pt-3">
                  <SheetLink item={CONTACT_LINK} onNavigate={closeSheet} />
                </div>
                <Link href={cta.href} onClick={closeSheet} className="mt-3">
                  <Button size="sm" className="w-full">
                    {cta.label}
                  </Button>
                </Link>
              </nav>
            </SheetContent>
          </Sheet>

          <nav
            aria-label="Primary"
            className="ah-nav-desktop"
            style={{ display: "flex", alignItems: "center", gap: 2 }}
          >
            {LEFT_LINKS.map((it) => (
              <NavLink key={it.name} href={it.href}>
                {it.name}
              </NavLink>
            ))}
            <NavMenu
              label="Resources"
              id="resources"
              open={open}
              setOpen={setOpen}
              items={RESOURCE_MENU}
            />
            {LEFT_TRAILING_LINKS.map((it) => (
              <NavLink key={it.name} href={it.href}>
                {it.name}
              </NavLink>
            ))}
          </nav>
        </div>

        <Link
          href={homeHref}
          aria-label="Alethia Labs home"
          style={{ textDecoration: "none", color: "inherit", display: "flex" }}
        >
          {/* Two sizes because the phone row is tight: at 375px the 24px lockup
              (~132px) leaves each side column less than the CTA needs. 20 is the
              lockup's documented floor with a tag (see lockup.tsx). */}
          <span className="ah-nav-desktop">
            <AlethiaLockup size={24} />
          </span>
          <span className="ah-nav-mobile">
            <AlethiaLockup size={20} />
          </span>
        </Link>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 2,
          }}
        >
          <nav
            aria-label="Company"
            className="ah-nav-desktop"
            style={{ display: "flex", alignItems: "center", gap: 2, marginRight: 10 }}
          >
            <NavMenu
              label="Company"
              id="company"
              open={open}
              setOpen={setOpen}
              align="right"
              items={COMPANY_MENU}
            />
            <NavLink href={CONTACT_LINK.href}>{CONTACT_LINK.name}</NavLink>
          </nav>
          <Link href={cta.href} style={{ flexShrink: 0 }}>
            <Button size="sm">
              {cta.label}
              <span className="ah-nav-desktop">
                <Icon k="arrow" size={14} />
              </span>
            </Button>
          </Link>
        </div>
      </Wrap>
    </header>
  );
}
