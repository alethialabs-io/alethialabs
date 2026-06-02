output "ecr_repository_url" {
  value = aws_ecr_repository.tendril.repository_url
}

output "tendrils" {
  description = "Per-region tendril cluster and service names"
  value = {
    for region, w in module.tendril : region => {
      cluster_name = w.cluster_name
      service_name = w.service_name
    }
  }
}

output "scaler_lambda" {
  value = module.scaler.lambda_function_name
}
