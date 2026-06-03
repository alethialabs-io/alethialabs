-- Allow users to update their own jobs (needed for cancel)
CREATE POLICY "Users can update their own jobs"
    ON public.provision_jobs FOR UPDATE
    USING (auth.uid() = user_id);
