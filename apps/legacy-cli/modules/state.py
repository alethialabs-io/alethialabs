#!./venv/bin/python3
import yaml
from modules.logs import LOGS

myLOGS = LOGS()

class IDPSTATE:
    # Define sensitive variables to be filtered out
    sensitive_vars = ["applications_argo_access_token", "gitops_argo_access_token"]

    def save_infra_facts(self, config, outputs=None, dry_run=False):
        myLOGS.log("normal", "Saving infra-facts.yaml")
        to_yaml = {}

        # Include top-level variables from the config, but filter out sensitive variables
        myLOGS.log("normal", "Including top-level variables from the config.")
        for key, value in vars(config).items():
            if key not in self.sensitive_vars and isinstance(value, (float, str, int, bool)):
                to_yaml[key] = value

        # Include terraform outputs
        if outputs:
            myLOGS.log("normal", "Including terraform outputs.")
            for key, output in outputs.items():
                to_yaml[key] = output["value"]
        else:
            if dry_run:
                myLOGS.log("normal", "No Terraform outputs found. This is expected in dry-run mode. "
                                        "The infra-facts.yaml will not be fully populated with outputs...")
            else:
                myLOGS.log("critical", "No Terraform outputs found in non-dry-run mode. Exiting.")
                exit(1)

        # Save the infra-facts YAML
        output = "temp/infra-facts.yaml"
        myLOGS.log("normal", f'Saving infra-facts.yaml file to: {output}')
        yaml_string = yaml.dump({"infra-services": to_yaml})
        with open(output, "w") as text_file:
            text_file.write(yaml_string)
