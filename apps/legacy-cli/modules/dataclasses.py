from dataclasses import dataclass
from typing import Literal, Dict, Any
from modules.logs import LOGS


myLOGS = LOGS()

@dataclass
class BucketOptions:
    name: str
    region: Literal[
        'af-south-1',
        'ap-east-1',
        'ap-northeast-1',
        'ap-northeast-2',
        'ap-northeast-3',
        'ap-south-1',
        'ap-south-2',
        'ap-southeast-1',
        'ap-southeast-2',
        'ap-southeast-3',
        'ca-central-1',
        'cn-north-1',
        'cn-northwest-1',
        'eu-central-1',
        'eu-north-1',
        'eu-south-1',
        'eu-south-2',
        'eu-west-1',
        'eu-west-2',
        'eu-west-3',
        'me-south-1',
        'sa-east-1',
        'us-east-2',
        'us-gov-east-1',
        'us-gov-west-1',
        'us-west-1',
        'us-west-2'
    ] = 'eu-west-1'
    acl: Literal[
        'private',
        'public-read',
        'public-read-write',
        'authenticated-read'
    ] = 'private'
    objectOwnership: Literal[
        'BucketOwnerPreferred',
        'ObjectWriter',
        'BucketOwnerEnforced'
    ] = 'BucketOwnerPreferred'
    objectLockEnabledForBucket: bool = True

@dataclass
class ConfigOptions:
    # Dynamically add fields to the dataclass
    def add_fields(self, config_dict: Dict[str, Any]):
        for key, value in config_dict.items():
            setattr(self, key, value)

    # Return None for any missing attributes
    def __getattr__(self, item):
        return None

    # Validate config and transform if needed
    def validate(self):
        # Mandatory fields to check for existence
        mandatory_fields = [
            'project_name', 'region', 'environment', 'aws_account_id', 'terraform_ver',
            'env_template_repo', 'env_template_repo_branch', 'env_git_repo',
            'gitops_template_repo', 'gitops_destination_repo', 'dns_hosted_zone', 'dns_main_domain'
        ]

        # Check for mandatory fields
        for field in mandatory_fields:
            if not hasattr(self, field) or not getattr(self, field):
                error_message = f"Mandatory field {field} is missing or empty."
                myLOGS.log("critical", error_message)
                raise ValueError(error_message)

        # Length constraints for specific fields
        # NOTE: currently those are just dummy values
        length_constraints = {
            "project_name": 15 if getattr(self, "allow_long_names", None) is False else 25,
            "environment": 5 if getattr(self, "allow_long_names", None) is False else 15,
        }

        # Check length constraints for specific fields
        for field, max_length in length_constraints.items():
            if hasattr(self, field):
                value = getattr(self, field)
                if len(value) > max_length:
                    error_message = (
                        f"Field '{field}' exceeds the maximum allowed length of {max_length} characters. "
                        f"Current length: {len(value)}."
                    )
                    myLOGS.log("critical", error_message)
                    raise ValueError(error_message)

        # Combined length check for project_name and environment
        combined_length = len(self.project_name) + len(self.environment)
        max_combined_length = 10 if getattr(self, "allow_long_names", None) is False else 30
        if combined_length > max_combined_length:
            error_message = (
                f"Combined length of project_name '{self.project_name}' and environment '{self.environment}' "
                f"exceeds the maximum of {max_combined_length} characters. Please use shorter names."
            )
            myLOGS.log("critical", error_message)
            raise ValueError(error_message)

        # Ensure repository fields end with '.git'
        if hasattr(self, "gitops_destination_repo") and not self.gitops_destination_repo.endswith(".git"):
            self.gitops_destination_repo += ".git"

        if hasattr(self, "applications_destination_repo") and self.applications_destination_repo and \
                not self.applications_destination_repo.endswith(".git"):
            self.applications_destination_repo += ".git"

    # Pretty print the dataclass
    def __repr__(self):
        result = [f'{self.__class__.__name__}(']

        fields = vars(self)

        for key, value in fields.items():
            result.append(f'  {key}: {value!r},')

        result.append(')')
        return '\n'.join(result)
