output "ecr_repository_url" {
  value = aws_ecr_repository.tendril.repository_url
}

output "tendrils" {
  description = "Per-tendril cluster and service names"
  value = {
    for name, w in module.tendril : name => {
      region       = var.tendrils[name].region
      trellis_url  = var.tendrils[name].trellis_url
      cluster_name = w.cluster_name
      service_name = w.service_name
    }
  }
}

output "scaler_lambda" {
  value = module.scaler.lambda_function_name
}
