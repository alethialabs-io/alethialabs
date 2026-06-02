-- Fix vines that have provision_network=false but no network selected.
-- These are invalid and cannot be planned. Reset to provision a new network.
UPDATE public.vine_network
SET provision_network = true
WHERE provision_network = false
  AND (network_id IS NULL OR network_id = '');
