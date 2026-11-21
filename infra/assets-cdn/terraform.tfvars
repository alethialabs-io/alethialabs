# COMMITTED ON PURPOSE — see infra/README.md "Inputs — a default is a decision". Every value here is
# public: the hostname and bucket name appear in every asset URL.
#
# `cloudflare_account_id` is the one input NOT here: it is required and supplied at apply time
# (TF_VAR_cloudflare_account_id or a gitignored account.auto.tfvars). See README.md.

zone_name   = "alethialabs.io"
hostname    = "assets.alethialabs.io"
bucket_name = "alethia-public-assets"

cors_origins = [
  "https://alethialabs.io",
  "https://www.alethialabs.io",
]

# True on the condition that README.md step 1 found the zone's Cache Rules page empty (verified
# 2026-11-21: no stack in this repo owns a cache-settings ruleset). If that page is not empty at apply
# time, set this to false — the edge still caches by Cache-Control — rather than overwrite those rules.
manage_cache_rule = true
