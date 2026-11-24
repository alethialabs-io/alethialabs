# COMMITTED ON PURPOSE (overriding infra/.gitignore; see .gitignore here). Every value is already
# public or is a design decision recorded in the open.
#
# Not here, on purpose:
#   console_writer_source_cidrs  the box's origin addresses → gitignored box.auto.tfvars
#   budget_alert_emails          personal addresses       → gitignored emails.auto.tfvars

# The existing `alethia-backup` member account (infra/backup-account/terraform.tfvars).
backup_account_id = "450956683176"

# The Alethia platform account, named only so a precondition can refuse backup_account_id == this.
alethia_account_id = "270587882865"

region = "eu-central-1"

# The Identity Center permission set whose roles are the backup account's human admins.
sso_admin_permission_set = "AdministratorAccess"

# The private books repository and its protected environment (main only).
books_github_repo        = "alethialabs-io/books"
books_github_environment = "books"

# Expected spend is about USD 1.5 a month (README "Cost").
monthly_budget_usd = 5
