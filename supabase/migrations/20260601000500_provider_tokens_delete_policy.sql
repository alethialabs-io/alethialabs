create policy "Users can delete their own tokens"
on public.provider_tokens for delete
using (auth.uid() = user_id);
