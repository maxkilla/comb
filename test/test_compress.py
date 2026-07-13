#!/usr/bin/env python3
"""Tests for the Hermes comb plugin (.hermes/plugins/comb/__init__.py).

Mirrors test/compress.test.js. Stdlib-only — run with:
    python3 test/test_compress.py
"""

import importlib.util
import os
import sys
import unittest
from pathlib import Path

_PLUGIN_PATH = Path(__file__).resolve().parent.parent / ".hermes" / "plugins" / "comb" / "__init__.py"


def _load_plugin():
    spec = importlib.util.spec_from_file_location("comb_hermes_plugin", _PLUGIN_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CompressTests(unittest.TestCase):
    def setUp(self):
        os.environ.pop("COMB_COMPRESS", None)
        self.comb = _load_plugin()

    def test_leaves_short_text_untouched(self):
        self.assertIsNone(self.comb.compress("short output"))

    def test_elides_middle_keeps_head_and_tail(self):
        head = "A" * 1200
        middle = "B" * 5000
        tail = "C" * 800
        result = self.comb.compress(head + middle + tail)
        self.assertTrue(result.startswith(head))
        self.assertTrue(result.endswith(tail))
        self.assertIn("elided", result)
        self.assertLess(len(result), len(head + middle + tail))

    def test_salvages_error_lines_from_elided_middle(self):
        head = "A" * 1200
        noise = "B\n" * 2000
        error_text = "Traceback (most recent call last):\nValueError: bad input\n"
        tail = "C" * 800
        result = self.comb.compress(head + noise + error_text + noise + tail)
        self.assertIn("Traceback (most recent call last):", result)
        self.assertIn("ValueError: bad input", result)

    def test_excludes_read_write_patch_skill_manage(self):
        big = "X" * 5000
        for tool in ("read_file", "write_file", "patch", "skill_manage"):
            with self.subTest(tool=tool):
                self.assertIsNone(
                    self.comb._on_transform_tool_result(tool_name=tool, args={}, result=big)
                )

    def test_compresses_other_tools_over_threshold(self):
        big = "X" * 5000
        out = self.comb._on_transform_tool_result(tool_name="terminal", args={}, result=big)
        self.assertIsNotNone(out)
        self.assertLess(len(out), len(big))

    def test_non_string_result_is_noop(self):
        self.assertIsNone(
            self.comb._on_transform_tool_result(tool_name="terminal", args={}, result={"foo": "bar"})
        )

    def test_kill_switch_disables_compression(self):
        os.environ["COMB_COMPRESS"] = "0"
        comb = _load_plugin()
        big = "X" * 5000
        self.assertIsNone(comb._on_transform_tool_result(tool_name="terminal", args={}, result=big))


if __name__ == "__main__":
    unittest.main()
