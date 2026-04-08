
import traceback
import logging
import sys
import os
from modules.colors import PCOLORS
from modules.arg_parser import parse_args
myCOLORS = PCOLORS()

class LOGS:
    logfile = "./logs/run.log"
    destination = "local"
    loglevel = 2

    def __init__(self, logfile: str="./logs/run.log"):
        os.makedirs(os.path.dirname(logfile), exist_ok=True)
        try:
            self.logfile = logfile
            argvs = parse_args()
            if (argvs.loglevel == "debug"):
                self.loglevel = 1
            elif (argvs.loglevel == "critical"):
                self.loglevel = 3
            else:
                pass
        except NameError:
            pass

    def log(self, status: str, log: str):
        from datetime import datetime
        today = datetime.now()
        colorStatus = myCOLORS.OKGREEN
        if (status == "debug"):
            colorStatus = myCOLORS.WARNING
        if (status == "critical"):
            colorStatus = myCOLORS.FAIL
        date = today.strftime("%Y-%m-%d %H:%M:%S")

        # STDOUT
        stdLine = "{}{}{}\n".format(
            colorStatus,
            log,
            myCOLORS.ENDC
        )
        if (status == "debug"):
            verbosity = 1
        elif (status == "critical"):
            verbosity = 3
        elif (status == "info"):
            verbosity = 2
        else:
            verbosity = 2

        if (verbosity >= self.loglevel):
            sys.stdout.write('\r                                                                                                    \r')
            sys.stdout.write(stdLine)
            
        # LOG
        logline = "[{}][{}] {}\n".format(
            date,
            status,
            log
        )
        if (self.destination == "local"):
            self.pushFile(logline)
        
    def pushFile(self, text):
        try:
            with open(self.logfile, "a") as logfile:
                logfile.write(text)
                return True
        except Exception as e:
            logging.error(traceback.format_exc())
            # Logs the error appropriately.

    def pushCloudWatch(self):
        pass

    def pushELK(self):
        pass