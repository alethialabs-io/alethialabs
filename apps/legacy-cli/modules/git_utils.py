from typing import Optional
import git
import os
import shutil
import jinja2
import yaml
from modules.logs import LOGS
from urllib.parse import urlparse

myLOGS = LOGS()


class GIT:
    def __init__(self, repo_url: str, local_path: str, dry_run: bool) -> None:
        self.repo_url = self._transform_url_to_ssh(repo_url)
        self.local_path = local_path
        self.repo: Optional[git.Repo] = None
        self.dry_run = dry_run

    def clone(self, branch: Optional[str] = None, force: bool = False) -> None:
        myLOGS.log("debug", f'Cloning {self.repo_url} into {self.local_path}')
        if os.path.exists(self.local_path) and not force and self._is_correct_repo():
            self.repo = git.Repo(self.local_path)
            if branch:
                self.repo.git.checkout(branch)
            self.reset_and_restore_changes()
            self.pull()
        else:
            shutil.rmtree(self.local_path, ignore_errors=True)
            os.makedirs(self.local_path, exist_ok=True)
            self.repo = git.Repo.clone_from(self.repo_url, self.local_path, branch=branch, depth=1)

    @staticmethod
    def _transform_url_to_ssh(url):
        # Check if URL is already in SSH format
        if url.startswith('git@'):
            return url

        parsed_url = urlparse(url)

        # Extract the host and path, and remove the leading slash from the path
        host = parsed_url.netloc
        path = parsed_url.path.lstrip('/')

        # Construct the SSH URL
        ssh_url = f"git@{host}:{path}"
        if not ssh_url.endswith('.git'):
            ssh_url += '.git'

        return ssh_url

    def _is_correct_repo(self) -> bool:
        try:
            repo = git.Repo(self.local_path)
            return any(remote.url == self.repo_url for remote in repo.remotes)
        except git.InvalidGitRepositoryError:
            return False

    def pull(self) -> None:
        assert self.repo is not None, "Repository not initialized"
        try:
            self.repo.git.pull()
        except git.exc.GitCommandError as e:
            if "no such ref was fetched" in e.stderr:
                myLOGS.log("debug", f'Remote repository {self.repo_url} is empty."')
            else:
                raise

    def push(self) -> None:
        origin = self.repo.remote(name='origin')
        if self.dry_run:
            myLOGS.log("debug", f"DRY_RUN: git commit/push for {self.repo_url} at {self.local_path}")
            myLOGS.log("debug", f'DRY_RUN: skipping commit')
            myLOGS.log("debug", f'DRY_RUN: skipping push')
        else:
            self.add_and_commit(f"idp-installer: auto-committing changes")
            myLOGS.log("debug", f'Pushing in {self.repo_url}"')

            try:
                push_result = origin.push()

                for push_info in push_result:
                    # Check if the ERROR flag is set using bitwise AND
                    if push_info.flags & (
                        git.remote.PushInfo.ERROR
                        | git.remote.PushInfo.REJECTED
                        | git.remote.PushInfo.REMOTE_FAILURE
                        | git.remote.PushInfo.REMOTE_REJECTED
                    ):
                        myLOGS.log("critical", f'Push failed: {push_info.summary}')
                        raise Exception(f"Push failed: {push_info.summary}")
            except git.exc.GitCommandError as e:
                myLOGS.log("critical", f"Git command error: {e.stderr}")
                raise


    def reset_and_restore_changes(self):
        assert self.repo is not None, "Repository not initialized"
        try:
            # Discard staged/unstaged changes
            self.repo.git.reset('--hard')

            # Remove untracked files and directories (with --force)
            self.repo.git.clean('-fd')

            myLOGS.log("debug", f"Reset staged and restored all changes in the working directory {self.local_path}.")
        except git.exc.GitCommandError as e:
            myLOGS.log("error", f"Error resetting and restoring changes: {e}")

    def add_and_commit(self, message: str) -> None:
        self.repo.git.add(A=True)
        self.repo.index.commit(message)

    def bootstrap(self, template_repo, repo_files_map: dict, update_repo: bool) -> None:
        changes = False
        ignore_files = ['.git', 'variable-template']

        if not self.file_exists('main.tf'):
            self.clear_repo_contents()
            self.copy_files(template_repo.local_path, self.local_path, ignore_files=ignore_files)
            changes = True
        elif update_repo:
            myLOGS.log("normal", f'Updating repo due to --update-infra or --update-all')
            self.copy_files(template_repo.local_path, self.local_path, ignore_files=ignore_files)
            changes = True
        else:
            myLOGS.log("warning", f'main.tf file exists and will not overwrite! Use --update-infra or --update-all to use the latest template changes')

        for var_file_src, var_file_dst in repo_files_map.items():
            full_var_file_dst_path = os.path.join(self.local_path, var_file_dst)
            if not self.file_exists(var_file_dst) or update_repo:
                os.makedirs(os.path.dirname(full_var_file_dst_path), exist_ok=True)
                shutil.copy2(os.path.join(template_repo.local_path, var_file_src), full_var_file_dst_path)
                changes = True
            else:
                myLOGS.log("warning", f'{var_file_dst} file exists and will not overwrite it! Use --update-infra or --update-all to use the latest template changes')

        if self.repo.is_dirty(untracked_files=True):
            myLOGS.log("debug", f'Found differences in repo that need to be committed')
            changes = True

        if changes:
            self.push()
        else:
            myLOGS.log("debug", f'No changes found in client tf repository')


    def bootstrap_app_repo(self, config, app_template_repo, applications_facts_path: str, update_repo: bool, update_infra_facts: bool = False) -> None:
        changes = False

        # We don't want those files/directories in the target repository
        ignore_files = ['.git', 'applications-argo-app.yaml']

        # Initial bootstrap
        if not self.file_exists('helm'):
            myLOGS.log("normal", f'Initial applications repo bootstrap')
            self.clear_repo_contents()
            self.copy_files(app_template_repo.local_path, self.local_path, ignore_files=ignore_files)
            changes = True
        elif update_repo:
            myLOGS.log("normal", f'Updating repo due to --update-gitops or --update-all')
            self.copy_files(app_template_repo.local_path, self.local_path, ignore_files=ignore_files)
            changes = True
        else:
            myLOGS.log("warning", f'helm/ directory exists and will not overwrite it! Use --update-gitops or --update-all to use the latest template changes')

        # Distribute infra-facts as values files
        helm_charts_path = os.path.join(app_template_repo.local_path, 'helm')
        all_charts = next(os.walk(helm_charts_path))[1]
        myLOGS.log("normal", f'Distributing infra-facts as values files for charts: {all_charts}')

        for chart_dir in all_charts:
            values_dst = os.path.join(self.local_path, 'helm', chart_dir, f'values/{config.environment}/{config.region}')
            is_infra_facts = False

            if chart_dir == 'applications':
                is_infra_facts = True
                values_src = applications_facts_path
                values_dst = os.path.join(values_dst, 'infra-facts.yaml')
            else:
                values_dst = os.path.join(values_dst, 'values.yaml')

            # Extra precaution. If outputs are malfomed do not overwrite the infra facts
            if is_infra_facts:
                with open(values_src) as stream:
                    applications_facts_yaml = yaml.safe_load(stream)
                    if not len(applications_facts_yaml.get('infra-services', {}).get('eks_cluster_name', '')) > 0:
                        myLOGS.log("warning", f'Sanity check not passed. {values_src} does not contain eks_cluster_name. {values_dst} will not be overwritten!')
                        continue

            if is_infra_facts:
                if update_infra_facts or update_repo or not os.path.exists(values_dst):
                    os.makedirs(os.path.dirname(values_dst), exist_ok=True)
                    shutil.copy2(values_src, values_dst)
                    myLOGS.log("debug", f'Copying values files to {values_dst}')
                    changes = True
                else:
                    myLOGS.log("warning", f'{values_dst} file exists and will not overwrite it! Use --update-gitops or --update-all to use the latest template changes')
            elif not os.path.exists(values_dst):
                os.makedirs(os.path.dirname(values_dst), exist_ok=True)
                with open(values_dst, 'w') as file:
                    file.write("# Add chart overrides for this environment/region here.\n")
                myLOGS.log("debug", f'Creating empty overrides file at {values_dst}')
                changes = True
            else:
                myLOGS.log("warning", f'{values_dst} file exists and will not overwrite it!')

        # Generate applications.yaml argo application per stage
        myLOGS.log("normal", f'Generating applications argo app')
        applications_argo_app_path_src = f'{app_template_repo.local_path}/applications-argo-app.yaml'
        applications_argo_app_path_dst = f'{self.local_path}/manifests/applications/applications-app-stages/{config.environment}/{config.region}/applications.yaml'

        with open(applications_argo_app_path_src, 'r') as stream:
            template = jinja2.Template(stream.read())

        # Render the template with values
        templated_content = template.render({'environment': config.environment, 'region': config.region, 'applications_destination_repo': config.applications_destination_repo})

        if update_repo or not os.path.exists(applications_argo_app_path_dst):
            os.makedirs(os.path.dirname(applications_argo_app_path_dst), exist_ok=True)
            with open(applications_argo_app_path_dst, 'w') as stream:
                stream.write(templated_content)
            myLOGS.log("debug", f'Copying applications argo app in {applications_argo_app_path_dst}')
            changes = True
        else:
            myLOGS.log("warning", f'{applications_argo_app_path_dst} file exists and will not overwrite it! Use --update-gitops or --update-all to use the latest template changes')

        # Manifests Jinja2 templating
        myLOGS.log("normal", f'Jinja2 templating manifests')
        manifests_src = os.path.join(app_template_repo.local_path, 'manifests')
        manifests_dst = os.path.join(self.local_path, 'manifests')

        for root, _, files in os.walk(manifests_src):
            for file in files:
                if file.endswith('.yaml') or file.endswith('.yml'):
                    yaml_file_src = os.path.join(root, file)

                    rel_path = os.path.relpath(yaml_file_src, manifests_src)
                    yaml_file_dst = os.path.join(manifests_dst, rel_path)
                    os.makedirs(os.path.dirname(yaml_file_dst), exist_ok=True)

                    with open(yaml_file_src, 'r') as stream:
                        template = jinja2.Template(stream.read())

                    # Render the template with the values
                    templated_content = template.render({'applications_destination_repo': config.applications_destination_repo})

                    # Check if the file exists AND if it contains unprocessed placeholders like {{ }}
                    with open(yaml_file_dst, 'r') as existing_file:
                        if update_repo or '{{' in existing_file.read():
                            # Write the templated content back to the destination file
                            with open(yaml_file_dst, 'w') as stream:
                                stream.write(templated_content)

                            changes = True
                            myLOGS.log("debug", f"Jinja2 rendered: {yaml_file_dst}")
                        else:
                            myLOGS.log("warning", f'{yaml_file_dst} file exists and will not overwrite it! Use --update-gitops or --update-all to use the latest template changes')


        if self.repo.is_dirty(untracked_files=True):
            myLOGS.log("debug", f'Found differences in repo that need to be committed"')
            changes = True

        if changes:
            self.push()
        else:
            myLOGS.log("debug", f'No changes found in client tf repository')

    def bootstrap_argo(self, config, argo_template_repo, infra_facts_path: str, update_repo: bool, update_infra_facts: bool = False) -> None:
        changes = False

        # We don't want those files/directories in the target repository
        ignore_files = ['.git', 'infra-services-argo-app.yaml']

        # We assume that if the helm directory exists that the repo was bootstrapped before
        # If it doesn't (or force it with --update-gitops flag):
        # we wipe it clean and copy the template from scratch
        if not self.file_exists('helm'):
            myLOGS.log("normal", f'Initial argocd repo bootstrap')
            self.clear_repo_contents()
            self.copy_files(argo_template_repo.local_path, self.local_path, ignore_files=ignore_files)
            changes = True
        elif update_repo:
            myLOGS.log("normal", f'Updating repo due to --update-gitops or --update-all')
            self.copy_files(argo_template_repo.local_path, self.local_path, ignore_files=ignore_files)
            changes = True
        else:
            myLOGS.log("warning", f'helm/ directory exists and will not overwrite it! Use --update-gitops or --update-all to use the latest template changes')

        # Locating the helm directory in the template repository
        helm_charts_path = os.path.join(argo_template_repo.local_path, 'helm')

        # Getting a list of all chart directories under helm/
        all_charts = next(os.walk(helm_charts_path))[1]
        # Excluding the argo-cd chart as it's values file is custom constructed below
        charts_filtered = [chart for chart in all_charts if chart != 'argo-cd']

        myLOGS.log("normal", f'Distributing infra-facts as values files for charts: {charts_filtered}')

        for chart_dir in charts_filtered:
            # e.g. ./helm/external-dns/values/dev/eu-west-1
            values_dst = os.path.join(self.local_path, 'helm', chart_dir, f'values/{config.environment}/{config.region}')
            is_infra_facts = False

            # For the infra-services chart we will copy the infra-facts.yaml to the values_dst
            if chart_dir == 'infra-services':
                is_infra_facts = True
                values_src = infra_facts_path
                values_dst = os.path.join(values_dst, 'infra-facts.yaml')
            # For all other charts we will create an empty overrides file if missing
            else:
                values_dst = os.path.join(values_dst, 'values.yaml')

            # Extra precaution. If outputs are malfomed do not overwrite the infra-facts
            if is_infra_facts:
                with open(values_src) as stream:
                    infra_facts_yaml = yaml.safe_load(stream)
                    if not len(infra_facts_yaml.get('infra-services', {}).get('eks_cluster_name', '')) > 0:
                        myLOGS.log("warning", f'Sanity check not passed. {values_src} does not contain eks_cluster_name. {values_dst} will not be overwritten!')
                        continue

            # Write the values file / infra-facts to the appropriate chart and stage
            if is_infra_facts:
                if update_infra_facts or update_repo or not os.path.exists(values_dst):
                    os.makedirs(os.path.dirname(values_dst), exist_ok=True)
                    shutil.copy2(values_src, values_dst)
                    myLOGS.log("debug", f'Copying values files to {values_dst}')
                    changes = True
                else:
                    myLOGS.log("warning", f'{values_dst} file exists and will not overwrite it! Use --update-gitops or --update-all to use the latest template changes')
            elif not os.path.exists(values_dst):
                os.makedirs(os.path.dirname(values_dst), exist_ok=True)
                with open(values_dst, 'w') as file:
                    file.write("# Add chart overrides for this environment/region here.\n")
                myLOGS.log("debug", f'Creating empty overrides file at {values_dst}')
                changes = True
            else:
                myLOGS.log("warning", f'{values_dst} file exists and will not overwrite it!')

        # Define values files for the ArgoCD helm chart
        argocd_values_dir = f"{self.local_path}/helm/argo-cd/values/{config.environment}/{config.region}"
        argocd_helm_chart_generated_values_path = f"{argocd_values_dir}/values.generated.yaml"
        argocd_helm_chart_user_values_path = f"{argocd_values_dir}/values.yaml"

        argocd_ui_dns = f'{config.project_name}-{config.region}-argocd-{config.environment}.{config.dns_main_domain}'
        argocd_values_data = {
            'server': {
                'ingress': {
                    'annotations': {
                        'external-dns.alpha.kubernetes.io/hostname': argocd_ui_dns
                    },
                    'hostname': f"{argocd_ui_dns}"
                }
            }
        }


        # Generate the templated values file for the ArgoCD helm chart when needed
        if update_repo or not os.path.exists(argocd_helm_chart_generated_values_path):
            os.makedirs(argocd_values_dir, exist_ok=True)
            with open(argocd_helm_chart_generated_values_path, 'w') as file:
                yaml.dump(argocd_values_data, file, default_flow_style=False)
            changes = True
            myLOGS.log("debug", f'Copying values files to {argocd_helm_chart_generated_values_path}')
        else:
            myLOGS.log("warning", f'{argocd_helm_chart_generated_values_path} file exists and will not overwrite it! Use --update-gitops or --update-all to use the latest template changes')

        # Create a user overrides values.yaml once, if missing
        if not os.path.exists(argocd_helm_chart_user_values_path):
            with open(argocd_helm_chart_user_values_path, 'w') as file:
                file.write("# Add Argo CD overrides for this environment/region here.\n")
            changes = True
            myLOGS.log("debug", f'Creating empty overrides file at {argocd_helm_chart_user_values_path}')

        # Generate the infra-services argocd application
        myLOGS.log("normal", f'Generating infra-services argo app')
        infra_services_argo_app_path_src = f'{argo_template_repo.local_path}/infra-services-argo-app.yaml'
        infra_services_argo_app_path_dst = f'{self.local_path}/manifests/applications/infra-app-stages/{config.environment}/{config.region}/infra-services.yaml'

        # Template the infra-services argocd application with jinja2
        with open(infra_services_argo_app_path_src, 'r') as stream:
            template = jinja2.Template(stream.read())
        templated_content = template.render({'environment': config.environment, 'region': config.region, 'gitops_destination_repo': config.gitops_destination_repo})

        # Write the infra-services argocd application to the destination
        if update_repo or not os.path.exists(infra_services_argo_app_path_dst):
            os.makedirs(os.path.dirname(infra_services_argo_app_path_dst), exist_ok=True)
            with open(infra_services_argo_app_path_dst, 'w') as stream:
                stream.write(templated_content)
            myLOGS.log("debug", f'Copying infra-services argo app in {infra_services_argo_app_path_dst}')
            changes = True
        else:
            myLOGS.log("warning", f'{infra_services_argo_app_path_dst} file exists and will not overwrite it! Use --update-gitops or --update-all to use the latest template changes')

        # Jinja2 templating and distributing the yaml manifests
        myLOGS.log("normal", f'Jinja2 templating manifests')
        manifests_src = os.path.join(argo_template_repo.local_path, 'manifests')
        manifests_dst = os.path.join(self.local_path, 'manifests')

        # Iterate all yaml manifest files
        for root, _, files in os.walk(manifests_src):
            for file in files:
                if file.endswith('.yaml') or file.endswith('.yml'):
                    yaml_file_src = os.path.join(root, file)

                    # Use the relative path to the source yaml to build the destination
                    rel_path = os.path.relpath(yaml_file_src, manifests_src)
                    yaml_file_dst = os.path.join(manifests_dst, rel_path)
                    os.makedirs(os.path.dirname(yaml_file_dst), exist_ok=True)

                    # Read and template the manifest
                    with open(yaml_file_src, 'r') as stream:
                        template = jinja2.Template(stream.read())

                    # Render the template with the values
                    templated_content = template.render({'gitops_destination_repo': config.gitops_destination_repo})

                    # Check if the file exists AND if it contains unprocessed placeholders like {{ }}
                    with open(yaml_file_dst, 'r') as existing_file:
                        if update_repo or '{{' in existing_file.read():
                            # Write the templated content back to the destination file
                            with open(yaml_file_dst, 'w') as stream:
                                stream.write(templated_content)

                            changes = True
                            myLOGS.log("debug", f"Jinja2 rendered: {yaml_file_dst}")
                        else:
                            myLOGS.log("warning", f'{yaml_file_dst} file exists and will not overwrite it! Use --update-gitops or --update-all to use the latest template changes')

        # Check for repo changes and push if any
        if self.repo.is_dirty(untracked_files=True):
            myLOGS.log("debug", f'Found differences in repo that need to be committed"')
            changes = True

        # If there were changes, push (--dry-run is handled inside the push() function)
        if changes:
            self.push()
        else:
            myLOGS.log("debug", f'No changes found in client tf repository')


    def clear_repo_contents(self) -> None:
        for item in os.listdir(self.local_path):
            path = os.path.join(self.local_path, item)
            if os.path.isfile(path):
                os.remove(path)
            elif os.path.isdir(path) and item != '.git':
                shutil.rmtree(path)

    @staticmethod
    def copy_files(src: str, dst: str, ignore_files: Optional[list[str]] = None) -> None:
        if not ignore_files:
            ignore_files = ['.git']
        for item in os.listdir(src):
            if item in ignore_files:
                continue
            s = os.path.join(src, item)
            d = os.path.join(dst, item)
            if os.path.isdir(s):
                shutil.copytree(s, d, dirs_exist_ok=True)
            else:
                shutil.copy2(s, d)

    def file_exists(self, file_path: str) -> bool:
        return os.path.exists(os.path.join(self.local_path, file_path))
