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

# The two halves of `public_access`, reported separately so a plan can be inspected without reading
# it by eye. checks_storage.tftest.hcl asserts BOTH — the prevention setting alone leaves a bucket
# nobody can read, and the binding alone cannot even be created.
output "bucket_public_access_prevention" {
  description = "Map of bucket suffixes to the public_access_prevention each bucket is planned with"
  value = {
    for key, bucket in google_storage_bucket.this : key => bucket.public_access_prevention
  }
}

output "publicly_readable_buckets" {
  description = "Bucket suffixes that carry an allUsers reader binding"
  value       = sort(keys(google_storage_bucket_iam_member.public_read))
}
