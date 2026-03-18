# UI/UX Overhaul: Vercel-like Aesthetic (Trellis)

## Objective
Transform the current "flashy" UI into a sophisticated, modern, and minimalist interface inspired by Vercel. We will strictly adhere to basic `shadcn/ui` conventions and correct the naming: **Trellis** for the Web Portal and **Grape** for the CLI.

**Current Task:** Refine the Dashboard Layout structure and responsive behavior. The current implementation in `DashboardLayout` does not use the full width effectively and has responsive issues.

## Detailed Plan for Dashboard Overhaul

### Phase 3.1: Dashboard Layout Structure (`apps/trellis/app/(private)/dashboard/layout.tsx`)
- [x] **Issue:** The main content area feels constrained or misaligned. The sidebar integration might be causing layout shifts.
- [x] **Action:** Rewrite the fundamental layout skeleton using a clean CSS Grid or Flexbox approach that guarantees full height (`h-screen`) and proper content scrolling, preventing the sidebar from overflowing or the main content from getting squished.
  - [x] Utilize a top-level `flex h-screen flex-col overflow-hidden` wrapper.
  - [x] Make the header a fixed `shrink-0` element.
  - [x] Make the main body a `flex flex-1 overflow-hidden` container.
  - [x] Inside the main body, the sidebar is a fixed width `shrink-0 overflow-y-auto` container, and the main content is `flex-1 overflow-y-auto p-8`.

### Phase 3.2: Dashboard Main Page (`apps/trellis/app/(private)/dashboard/page.tsx`)
- [x] **Issue:** Once the layout container is fixed to use full width, the content inside `page.tsx` needs to expand naturally without arbitrary `max-w-[1200px]` constraints unless necessary for reading comfort.
- [x] **Action:** Ensure grid columns adapt smoothly to the new layout structure. Use responsive grid classes (`grid-cols-1 md:grid-cols-2 xl:grid-cols-4`).

### Phase 3.3: Navigation & Typography Polish
- [x] Ensure all borders use `border-border/40` for a subtle, sophisticated line.
- [x] Use `text-sm` for sidebar items, `text-xs` for secondary descriptions.
- [x] Ensure the Trellis logo and header elements align perfectly.