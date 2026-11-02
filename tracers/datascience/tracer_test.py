"""Runs under CPython (no Pyodide): npm run test:tracers."""
import inspect
import unittest

import tracer


class TracerInterfaceTest(unittest.TestCase):
    def test_exposes_install_run_reset(self):
        self.assertEqual(inspect.signature(tracer.install).parameters.keys(), set())
        self.assertEqual(list(inspect.signature(tracer.run).parameters), ["code"])
        self.assertEqual(inspect.signature(tracer.reset).parameters.keys(), set())


if __name__ == "__main__":
    unittest.main()
