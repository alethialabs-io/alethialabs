module "pubsub" {
  source = "./modules/pubsub"
  count  = var.create_pubsub ? 1 : 0

  project_id   = var.project_id
  environment  = var.environment
  project_name = var.project_name

  topics = var.pubsub_topics

  labels = local.gcp_default_labels
}
