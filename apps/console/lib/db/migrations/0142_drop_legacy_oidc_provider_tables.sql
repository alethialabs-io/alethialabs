-- 0142: drop the legacy in-core oidc-provider tables. **This is a deliberate data cutover.**
--
-- better-auth 1.7 REMOVED the in-core `oidcProvider` plugin whose schema these three tables are.
-- `mcp()` is now `oauthProvider()` with an extra hook, and its models (created in 0143) are a
-- different set that merely shares two names. `oauth_application` has no counterpart at all — it
-- became `oauth_client` with ~31 more columns, `redirectUrls` (a single string) split into a
-- `redirectUris` array, and `metadata` moved from text to jsonb.
--
-- The upgrade guide is explicit that the records do not carry over:
--
--   "Expire the old access tokens, then drop or rename the legacy `oauthAccessToken` table before
--    creating the 1.7 token tables. The CLI does not copy these records or rename
--    `oauthAccessToken.accessToken` to `token`."
--
-- ── What this costs, stated plainly ──
--
-- Every issued MCP access token stops working at deploy, and every registered OAuth client is gone.
-- In practice: anyone who has connected Alethia as a Claude / claude.ai connector must reconnect.
-- There is no migration path that preserves them — the token format, the client record shape and
-- the consent model all changed together. This was accepted deliberately rather than discovered.
--
-- DROP ... CASCADE is used because `oauth_access_token` and `oauth_consent` carry FKs to
-- `oauth_application.client_id`; dropping the parent without CASCADE would fail on them. Nothing
-- outside this trio references any of the three — the only code that touched them was the Better
-- Auth adapter's schema map, and no application query reads them.
--
-- Split from 0143 rather than merged with it because a single diff makes the rename ambiguous:
-- drizzle-kit cannot tell `oauth_application` -> `oauth_client` from a drop plus a create, and asks
-- interactively. Two migrations state the intent unambiguously — and the intent IS drop-then-create,
-- not rename, precisely because no data survives.

DROP TABLE "oauth_access_token" CASCADE;--> statement-breakpoint
DROP TABLE "oauth_application" CASCADE;--> statement-breakpoint
DROP TABLE "oauth_consent" CASCADE;