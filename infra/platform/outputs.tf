output "ecr_repository_url" {
  value = aws_ecr_repository.tendril.repository_url
}

output "nodes" {
  description = "Per-tendril cluster and service names"
  value = {
    for name, w in local.all_worker_modules : name => {
      region       = var.nodes[name].region
      vertex_url  = var.nodes[name].vertex_url
      cluster_name = w.cluster_name
      service_name = w.service_name
    }
  }
}

output "scaler_lambda" {
  value = module.scaler.lambda_function_name
}
