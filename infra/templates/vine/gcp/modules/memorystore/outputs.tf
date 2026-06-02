output "host" {
  description = "Hostname or IP address of the Redis instance"
  value       = google_redis_instance.this.host
}

output "port" {
  description = "Port number of the Redis instance"
  value       = google_redis_instance.this.port
}

output "current_location_id" {
  description = "The current zone where the Redis primary node is located"
  value       = google_redis_instance.this.current_location_id
}
