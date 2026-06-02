locals {
  eks_cluster_admin_entries = {
    for admin in var.cluster_admins : admin.username => {
      principal_arn = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:user${admin.path}${admin.username}"
      type          = "STANDARD"
      policy_associations = {
        admin = {
          policy_arn = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy"
          access_scope = {
            type = "cluster"
          }
        }
      }
    }
  }

  merged_access_entries = merge(
    local.eks_cluster_admin_entries,
    var.access_entries,
  )
}
