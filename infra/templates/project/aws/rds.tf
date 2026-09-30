module "rds_maindb" {
  count = var.create_rds ? 1 : 0

  depends_on = [module.common_vpc]

  source = "./modules/rds"

  environment = var.environment

  aws_region     = var.region
  aws_account_id = var.aws_account_id
  project_name   = var.project_name

  rds_vpc_id  = try(module.common_vpc[0].vpc_id, null) != null ? module.common_vpc[0].vpc_id : var.vpc_id
  rds_subnets = try(module.common_vpc[0].database_subnets, null) != null ? module.common_vpc[0].database_subnets : var.vpc_private_subnet_ids
  # The cluster's node security group is what the DB admits traffic from — but a database is
  # provisionable WITHOUT a cluster (`create_rds = true, provision_eks = false`), and the unguarded
  # [0] failed the whole plan there (#1772). An empty list means "no cluster to admit";
  # rds_allowed_cidr_blocks remains the caller's other way in.
  #
  # THE SHAPE HERE IS THE TEMPLATE-WIDE RULE, and this site is where each rejected alternative was
  # measured. It is `try(module.eks[0].<out>, null) != null ? … : <fallback>` — a probe on ONE
  # OUTPUT OF ONE INSTANCE, with the traversal repeated OUTSIDE the try(). Three near-neighbours
  # all fail, each for a different reason:
  #
  #   - `length(module.eks) > 0` and `module.eks[*]` reference the module AS A WHOLE, and here that
  #     closes a dependency CYCLE `tofu validate` refuses outright: module.eks reads
  #     local.secrets_kms_key_arns + local.eso_secret_arns, both of which read module.rds_maindb,
  #     which would then wait on module.eks. (Those two locals now probe per instance for exactly
  #     this reason, which is what makes the aws graph robust rather than merely acyclic today.)
  #   - a bare `try(module.eks[0].node_security_group_id, [])` swallows every evaluation error, not
  #     just the empty-tuple one, so the day `node_security_group_id` is renamed in modules/eks a
  #     NORMAL `provision_eks = true` apply silently degrades to an Aurora cluster with no cluster
  #     ingress instead of failing the plan. Repeating the traversal outside the try() keeps that a
  #     validation error.
  #   - `var.provision_eks ?` — what this line used to say — adds no graph edge at all and IS
  #     short-circuited when known, which is why it was correct for #1772. It is wrong for #3351:
  #     under `tofu plan -refresh-only` the variable is TRUE while module.eks has no instance in
  #     state, so the index reaches an empty tuple and aborts the whole refresh. Only a predicate
  #     on the INSTANCE can tell those two states apart.
  #
  # Enforced by scripts/check-templates-refresh-safe.mjs; its header carries the full table (#3509).
  #
  # AND THE LIST'S LENGTH MUST BE PLAN-KNOWN, which is why the probe sits INSIDE the list rather
  # than choosing between `[id]` and `[]`. cloudposse/rds-cluster counts its ingress rule on
  # `length(var.security_groups)`, and on a FRESH stack the node security group id is known only
  # after apply — so `try(…, null) != null` is itself unknown, the list's length is unknown, and the
  # plan dies with "Invalid count argument" before anything exists. #3509 shipped exactly that:
  # every fresh aws stack with a database failed its first plan from 2026-09-01 (first seen on the
  # keyless-db floor run 36711770548; the aws maxconfig proof, #2813, predates it). An existing
  # stack never saw it because its node SG id is read from state. The length now follows
  # `var.provision_eks` (via local.eks_configured — see locals.tf for why a local), which adds no
  # graph edge and is always known; the ELEMENT stays probed, so
  # the refresh-only case (#3351 — provision_eks true, module.eks not in state) yields `[null]`
  # rather than an index abort. null is an accepted value for the rule's OPTIONAL
  # source_security_group_id, and that rule has no state instance to refresh in that case.
  # Enforced by the same guard (a probe may not choose a list's LENGTH).
  rds_security_groups = local.eks_configured ? [try(module.eks[0].node_security_group_id, null) != null ? module.eks[0].node_security_group_id : null] : []

  rds_allowed_cidr_blocks = var.rds_allowed_cidr_blocks

  rds_config = ({
    engine         = var.rds_config.engine
    engine_version = var.rds_config.engine_version
    engine_mode    = var.rds_config.engine_mode
    cluster_family = var.rds_config.cluster_family
    cluster_size   = var.rds_config.cluster_size
    db_port        = var.rds_config.db_port
    db_name        = var.rds_config.db_name
  })

  rds_scaling_config = var.rds_scaling_config
  rds_instance_type  = var.rds_instance_type

  rds_iam_auth_enabled = var.rds_iam_auth_enabled
  rds_default_username = var.rds_default_username
  # Threaded since #4320: it was declared here and in modules/rds with byte-identical defaults but
  # never passed, so the module's copy of the default always won and a caller's value was dropped.
  # Because the two defaults are identical, wiring it changes nothing for a caller who never set it.
  rds_extra_credentials = var.rds_extra_credentials

  rds_logs_exports = var.rds_logs_exports

  #enable_rds_s3_exports = var.enable_rds_s3_exports

  rds_tags = local.aws_default_tags

  rds_backup_retention_period = var.rds_backup_retention_period

  rds_cluster_parameters = var.rds_cluster_parameters
}
