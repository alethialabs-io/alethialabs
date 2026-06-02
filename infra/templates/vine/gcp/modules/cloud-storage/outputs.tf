output "bucket_names" {
  description = "Map of bucket suffixes to their full names"
  value = {
    for key, bucket in google_storage_bucket.this : key => bucket.name
  }
}

output "bucket_urls" {
  description = "Map of bucket suffixes to their gs:// URLs"
  value = {
    for key, bucket in google_storage_bucket.this : key => bucket.url
  }
}
