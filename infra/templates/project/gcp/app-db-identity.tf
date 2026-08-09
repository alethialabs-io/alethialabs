#########################################################################
##        Keyless app→Cloud SQL identity (Workload Identity)  #722      ##
#########################################################################
# When Cloud SQL has IAM authentication enabled, the app workload connects to it KEYLESSLY:
# a Google service account is bound (via GKE Workload Identity) to the in-cluster app KSA and
# registered as a CLOUD_IAM_SERVICE_ACCOUNT database user (see modules/cloud-sql). The app pod runs
# the Cloud SQL Auth Proxy sidecar (--auto-iam-authn), which mints a short-lived IAM token from this
# identity — the workload holds NO database password.
#
# The KSA the app runs as is created + annotated by the generated GitOps manifests (the keyless
# manifest lane, #722): namespace/name below MUST match `manifests` keylessKSANamespace/keylessKSAName.
#
# ADOPTION, and why this template no longer creates the account or grants its roles:
#
#   `roles/cloudsql.client` and `roles/cloudsql.instanceUser` are PROJECT-scoped only. A Cloud SQL
#   instance is not IAM-policy-bearing — the Admin API exposes no get/setIamPolicy on instances and
#   there is no google_sql_database_instance_iam_member in the provider, so the zone-scoped /
#   per-secret trick used for external-dns and external-secrets has no Cloud SQL analogue. Google's
#   own recipe narrows to an instance by putting a CONDITION on a project-level binding; the binding
#   is still project-level.
#
#   Writing one needs resourcemanager.projects.setIamPolicy, which the provisioner deliberately does
#   NOT hold — #300 stripped project-scoped IAM from this template precisely to drop that
#   owner-equivalent permission. #722 reintroduced two project bindings here a week later and they
#   were the only survivors of that purge; they 403 on every apply. GCP has no principal-pattern
#   condition (no aws:PrincipalArn analogue), so the grant also cannot be pre-written against a
#   per-deploy identity, whose email derives from region/environment/project_name.
#
#   So the account is created and granted ONCE by the customer in the connector bootstrap module
#   (infra/connector/gcp), under their own admin rights, and adopted here via
#   var.cloud_sql_app_service_account_email. Same shape as external_secrets_service_account_email.
#
#   TRADE-OFF, accepted deliberately: one stable account per customer GCP project replaces one per
#   environment, so it becomes a Cloud SQL database user on EVERY instance in that project — one
#   environment's app identity can log in to another environment's instance. The SQL GRANTs issued
#   by the keyless bootstrap Job still scope what it may do inside each database. This is accepted
#   because the isolation boundary that matters is the customer's GCP project, and it is stated in
#   the connector docs rather than left to be discovered.
#
#   OPT-IN: leaving the variable empty leaves keyless off and the app keeps using the BUILT_IN
#   password user. Nothing 403s either way.

locals {
  # Coupling point with packages/core/manifests (keylessKSAName / keylessKSANamespace).
  app_ksa_namespace = "default"
  app_ksa_name      = "alethia-app"

  # What the OPERATOR ASKED FOR, cluster-independent — checks_data.tf judges this, so the
  # keyless_cloud_sql_app_identity_wired warning keeps firing on a cluster-less shape instead of
  # going silent the moment the build predicate learned about the cluster.
  app_db_iam_requested = var.create_cloud_sql && var.cloud_sql_iam_auth

  # Whether the operator supplied an account to adopt. Keyless cannot be wired without one — see
  # the ADOPTION note above — so this is the second half of the build predicate.
  app_db_adopted = var.cloud_sql_app_service_account_email != ""

  # What gets BUILT additionally needs the cluster, for the same reason as registry-pull.tf's
  # enable_gar_pull: google_service_account_iam_member.app_db_wi below binds this GSA into the GKE
  # WORKLOAD IDENTITY POOL, which is created BY the cluster and named as a plain STRING — so with
  # `create_cloud_sql = true, cloud_sql_iam_auth = true, provision_gke = false` it planned clean and
  # failed at APPLY with "Error 400: Identity Pool does not exist". Azure gates the equivalent local
  # on `var.provision_aks` (app-db-identity.tf) and AWS's RDS-IAM IRSA role now gates on
  # `var.provision_eks`; this is the GCP parity for #1772.
  #
  # Consequence, deliberately: with no cluster — or with no adopted account — cloud-sql.tf registers
  # no CLOUD_IAM_SERVICE_ACCOUNT database user. That is the honest answer (the identity's whole
  # purpose is to be impersonated by an in-cluster KSA), and the check in checks_data.tf still says
  # so out loud rather than letting it pass unremarked.
  enable_app_db_iam = var.provision_gke && local.app_db_iam_requested && local.app_db_adopted
}

# The adopted account. READ, never created — a wrong or absent email then fails the PLAN, loudly,
# instead of provisioning a cluster whose app can authenticate to nothing (same rationale as
# data.google_service_account.external_secrets_adopted in workload-identity.tf).
data "google_service_account" "app_db_adopted" {
  count      = local.enable_app_db_iam ? 1 : 0
  project    = var.project_id
  account_id = var.cloud_sql_app_service_account_email
}

# Bind the adopted GSA to the app KSA via Workload Identity, so a pod running as that KSA
# impersonates it with no static key. This is a GSA-SCOPED policy write — iam.serviceAccounts.
# setIamPolicy, which the provisioner holds through the custom alethiaServiceAccountProvisioner role
# — not a project one, which is the whole point. `member` names the WI pool as a STRING, so the
# dependency on the cluster must be explicit (same race as external_dns_wi — Identity Pool does not
# exist otherwise).
resource "google_service_account_iam_member" "app_db_wi" {
  count              = local.enable_app_db_iam ? 1 : 0
  service_account_id = data.google_service_account.app_db_adopted[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[${local.app_ksa_namespace}/${local.app_ksa_name}]"

  depends_on = [module.gke]
}

# Migration (#722 → adoption). Destroying a google_project_iam_member ALSO calls
# resourcemanager.projects.setIamPolicy, so an environment that somehow holds these in state would
# turn today's apply-time 403 into a destroy-time one. The 403 means they were almost certainly
# never created, but forgetting is free and destroying is not: drop them from state, touch nothing
# in the cloud. The customer's bootstrap module now owns these grants.
removed {
  from = google_project_iam_member.app_db_client

  lifecycle {
    destroy = false
  }
}

removed {
  from = google_project_iam_member.app_db_instance_user

  lifecycle {
    destroy = false
  }
}

# The per-deploy account itself is safe to destroy — the provisioner holds iam.serviceAccounts.delete
# — but an environment that had one switches to the adopted identity, and if none was supplied
# keyless goes off and the app falls back to the BUILT_IN password user.
removed {
  from = google_service_account.app_db

  lifecycle {
    destroy = true
  }
}
