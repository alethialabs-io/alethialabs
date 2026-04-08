import yaml
import sys
from modules.dataclasses import ConfigOptions
from modules.logs import LOGS

myLOGS = LOGS()

class CONFIG:
    def __init__(self, filename):
        self.filename = filename

    def read(self):
        myLOGS.log("warn", f'Read configuration file: {self.filename}')
        with open(self.filename) as stream:
            content = yaml.safe_load(stream)

        # Create a ConfigOptions instance and dynamically add the fields
        config_options = ConfigOptions()
        config_options.add_fields(content)

        # Validate the configuration to ensure all fields and constraints are correct
        config_options.validate()

        return config_options
