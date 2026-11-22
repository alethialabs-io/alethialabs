# COMMITTED ON PURPOSE (overriding infra/.gitignore; see .gitignore here). Every value is already
# public or is a design decision recorded in the open.
#
# Not here, on purpose:
#   backup_account_id    the account does not exist yet. After README step 1, add it below in a
#                        one-line PR (or pass TF_VAR_backup_account_id for the first plan).
#   writer_source_cidrs  the box's origin addresses → gitignored box.auto.tfvars
#   budget_alert_emails  personal addresses       → gitignored emails.auto.tfvars

# The Alethia platform account, named only so a precondition can refuse backup_account_id == this.
alethia_account_id = "270587882865"

# Next to the production vault `alethia/prod/env`.
backup_region = "eu-central-1"

# The Identity Center permission set whose roles are the backup account's human admins.
sso_admin_permission_set = "AdministratorAccess"

# BACKUP_PREFIX in deploy/prod/backup/backup.env.example.
backup_prefix = "alethia-prod"

github_repo   = "alethialabs-io/alethialabs"
github_branch = "main"

# 4 vCPU / 16 GB, spot. The lifetime bounds a stuck instance; it is not a measured restore time —
# no drill has run yet, so BKP-L3's first run is what tells whether four hours is generous or tight.
drill_instance_type        = "m6i.xlarge"
drill_max_lifetime_minutes = 240

# Expected spend is USD 3–5 a month (README "Cost").
monthly_budget_usd = 15
