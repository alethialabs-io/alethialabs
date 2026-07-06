# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# (Intentionally empty.) This file previously held the Cloudflare Zero-Trust Access apps
# gating the self-hosted Umami analytics dashboard (analytics.<domain>). Umami was
# decommissioned on the hosted box — prod analytics moved to PostHog — so the Access
# apps, their policies, and the analytics_host/access_count locals were removed. The
# provider-agnostic analytics layer in apps/console still supports Umami/OpenReplay as
# opt-in OSS self-host providers; they are simply no longer deployed on alethialabs.io.
