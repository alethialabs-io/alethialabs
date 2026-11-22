# COMMITTED ON PURPOSE — see infra/README.md "Inputs — a default is a decision". Every value here is
# public. `cloudflare_account_id` and `status_probe_token` are NOT here: both are required and
# supplied at apply time (packages/status/README.md, "Deploying").

zone_name = "alethialabs.io"
hostname  = "status.alethialabs.io"
