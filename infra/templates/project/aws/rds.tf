module "rds_maindb" {
  count = var.create_rds ? 1 : 0

  depends_on = [module.common_vpc]

  source = "./modules/rds"

  environment = var.environment

  aws_region     = var.region
  aws_account_id = var.aws_account_id
  project_name   = var.project_name

  rds_vpc_id  = var.provision_vpc ? module.common_vpc[0].vpc_id : var.vpc_id
  rds_subnets = var.provision_vpc ? module.common_vpc[0].database_subnets : var.vpc_private_subnet_ids
  # The cluster's node security group is what the DB admits traffic from — but a database is
  # provisionable WITHOUT a cluster (`create_rds = true, provision_eks = false`), and the unguarded
  # [0] failed the whole plan there (#1772). An empty list means "no cluster to admit";
  # rds_allowed_cidr_blocks remains the caller's other way in.
  #
  # `var.provision_eks ?`, NOT the `length(module.eks) > 0` / `module.eks[*]` form used in outputs.tf.
  # Both of those reference the module AS A WHOLE, and here that closes a dependency CYCLE that
  # `tofu validate` refuses outright: module.eks reads local.secrets_kms_key_arns +
  # local.eso_secret_arns, both of which read module.rds_maindb, which would then wait on module.eks.
  # Testing the plain VARIABLE adds no graph edge at all, so the only module.eks reference left here
  # is the single output — the edge stays output-to-output and the graph stays acyclic.
  #
  # And NOT `try()`, which was the first shape of this fix: try() swallows every evaluation error,
  # not just the empty-tuple one, so the day `node_security_group_id` is renamed in modules/eks a
  # NORMAL `provision_eks = true` apply silently degrades to an Aurora cluster with no cluster
  # ingress instead of failing the plan. A ternary on a known variable short-circuits — the untaken
  # branch is never evaluated — so it is exactly as safe and stays fail-closed.
  rds_security_groups = var.provision_eks ? [module.eks[0].node_security_group_id] : []

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

  rds_logs_exports = var.rds_logs_exports

  #enable_rds_s3_exports = var.enable_rds_s3_exports

  rds_tags = local.aws_default_tags

  rds_backup_retention_period = var.rds_backup_retention_period

  rds_cluster_parameters = var.rds_cluster_parameters
}
