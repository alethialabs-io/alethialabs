#!./venv/bin/python3
import unittest
from modules.logs import LOGS
myLOGS = LOGS("temp/unittest.log")

class TestStringMethods(unittest.TestCase):

    def test_log_pushFile(self):
        self.assertTrue( myLOGS.pushFile(text="asd") )

    def test_log_log1(self):
        self.assertIsNone( myLOGS.log("critical", "test critical") )

    def test_log_log2(self):
        self.assertIsNone( myLOGS.log("normal", "test normal") )

    def test_log_log3(self):
        self.assertIsNone( myLOGS.log("debug", "test debug") )

if __name__ == '__main__':
    unittest.main()