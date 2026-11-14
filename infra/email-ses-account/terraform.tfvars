# COMMITTED ON PURPOSE (overriding infra/.gitignore; see .gitignore here). Every value is already
# public: Alethia's own account ids, the sending domain and the public webhook URL.
#
# The one input that cannot live here is ses_alarm_emails (personal addresses, public repo). It is
# REQUIRED; put it in the gitignored emails.auto.tfvars (see terraform.tfvars.example).

# The dedicated `alethia-email` member account, which holds SES production access in eu-central-1.
email_account_id = "604925221417"

# The Alethia platform account, named only so a precondition can refuse email_account_id == this.
alethia_account_id = "270587882865"

email_region = "eu-central-1"

# The domain identity, verified in the email account with Easy DKIM before this stack exists. This
# stack READS it (identity.tf); it does not create or import it.
domain = "alethialabs.io"

# The console's SES event webhook. null skips the HTTPS subscription (README step 3 explains when
# you would want that). The console must be serving a build that accepts this account's topic ARN
# before the subscription is created, because SNS confirms it by calling this URL.
events_webhook_url = "https://alethialabs.io/api/webhooks/ses"

# An optional aws:SourceIp lock on the sender's send permission. Empty means no IP condition: the
# production box's egress address changes whenever infra/cp-hetzner re-provisions it, and a stale
# lock turns every sign-in email into an AccessDenied. README "Sending credentials" says how to
# turn it on once the address is stable.
sender_source_cidrs = []
