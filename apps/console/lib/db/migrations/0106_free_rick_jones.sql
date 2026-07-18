CREATE TYPE "public"."service_binding_facet" AS ENUM('endpoint', 'port', 'username', 'password', 'connection_string');--> statement-breakpoint
CREATE TYPE "public"."service_binding_kind" AS ENUM('database', 'cache', 'queue', 'secret');--> statement-breakpoint
CREATE TYPE "public"."topic_subscription_protocol" AS ENUM('https', 'sqs', 'email', 'lambda');