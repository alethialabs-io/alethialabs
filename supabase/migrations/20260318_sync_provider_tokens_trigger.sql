-- Supabase handles provider tokens during linking by updating auth.identities
-- We will sync these tokens into our public.provider_tokens table automatically.

CREATE OR REPLACE FUNCTION public.handle_new_identity()
RETURNS trigger AS $$
BEGIN
  -- Only sync if there is actually a provider token in the payload
  IF NEW.identity_data->>'provider_token' IS NOT NULL THEN
    INSERT INTO public.provider_tokens (user_id, provider, access_token, refresh_token, updated_at)
    VALUES (
      NEW.user_id,
      NEW.provider,
      NEW.identity_data->>'provider_token',
      NEW.identity_data->>'provider_refresh_token',
      now()
    )
    ON CONFLICT (user_id, provider) 
    DO UPDATE SET 
      access_token = EXCLUDED.access_token,
      refresh_token = EXCLUDED.refresh_token,
      updated_at = now();
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Drop the trigger if it already exists to allow rerunning
DROP TRIGGER IF EXISTS on_identity_linked ON auth.identities;

-- Create the trigger
CREATE TRIGGER on_identity_linked
  AFTER INSERT OR UPDATE ON auth.identities
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_identity();
