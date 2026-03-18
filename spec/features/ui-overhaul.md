# UI/UX Overhaul: Vercel-like Aesthetic (Trellis)

## Objective
Transform the current "flashy" UI (gradients, bright cyan/purple colors) into a sophisticated, modern, and minimalist interface inspired by Vercel. We will strictly adhere to basic `shadcn/ui` conventions, utilizing a monochrome/neutral palette, crisp typography, and generous whitespace. 

**Correct Nomenclature:**
*   **Trellis:** The Web Portal / Platform.
*   **Grape:** The CLI tool.

## General Design Principles
*   **Color Palette:** Remove `bg-gradient-to-br`, `from-cyan-500`, `to-purple-600` classes. Replace with semantic tailwind classes (`bg-background`, `text-foreground`, `text-muted-foreground`, `border-border`).
*   **Components:** Rely on standard `shadcn/ui` variants (`variant="outline"`, `variant="ghost"`, `variant="default"`).
*   **Borders & Shadows:** Use subtle borders (`border`, `border-border/40`) and small shadows (`shadow-sm`) instead of heavy dropshadows or colored borders.
*   **Typography:** Maintain clear visual hierarchy using `tracking-tight` for headings and standard sans/mono fonts.

## Phase 1: Authentication Pages
- [x] Correct nomenclature: Replace "ItGix Grape" with "Trellis".
- [x] **`SignInPage` (`apps/trellis/app/(public)/auth/signin/page.tsx`)**
  - Made background pure `bg-background`.
  - Back links and text use muted neutral colors.
- [x] **`SignInForm` (`apps/trellis/components/forms/signin-form.tsx`)**
  - Restored the Google login button.
  - Removed cyan/colored accents from the "magic link sent" state.
  - Ensured all OAuth buttons use `variant="outline"` with a standard neutral hover state.

## Phase 2: Landing Page
- [x] **`HomePage` (`apps/trellis/app/page.tsx`)**
  - Removed all bright gradients from the Hero section.
  - Updated Features grid: cleaner monochrome/neutral styling.
  - Simplified the header and corrected naming to "Trellis".
  - Made the CTA section a clean, neutral box.

## Phase 3: Dashboard Layout & Navigation
- [x] **`DashboardLayout` (`apps/trellis/app/(private)/dashboard/layout.tsx`)**
  - Simplified top header and corrected naming.
  - Updated sidebar navigation: neutral hover and active states (`bg-muted text-foreground`).
  - Neutralized the "Missing AWS Connection" alert.

## Phase 4: Dashboard Overview Page
- [x] **`DashboardPage` (`apps/trellis/app/(private)/dashboard/page.tsx`)**
  - Removed colored borders and tinted backgrounds from Stats cards.
  - Simplified Quick Actions and Configuration List styling.
  - Corrected nomenclature.

## Phase 5: Configurations & Setup
- [x] **`ConfigurationsList` (`apps/trellis/app/(private)/dashboard/configurations/page.tsx`)**
- [x] **`ConfigurationWizard` (`apps/trellis/components/configuration-form.tsx`)**
- [x] **`AWSOnboarding` (`apps/trellis/app/(private)/onboarding/aws/page.tsx`)**

## Phase 6: Sub-pages & Components
- [x] **`HistoryPage` (`apps/trellis/app/(private)/dashboard/history/page.tsx`)**
- [x] **`ProfilePage` (`apps/trellis/app/(private)/dashboard/profile/page.tsx`)**
- [x] **`LinkedAccounts` (`apps/trellis/components/linked-accounts.tsx`)**
- [x] **`ClustersPage` (`apps/trellis/app/(private)/dashboard/clusters/page.tsx`)**
- [x] **`ClusterList` (`apps/trellis/components/clusters/cluster-list.tsx`)**
