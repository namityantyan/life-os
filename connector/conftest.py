"""pytest bootstrap for the connector.

* Puts this folder on sys.path so the flat Windows modules import the same way they do on the PC.
* Registers a `windows_mt5` alias package pointing at the SAME module objects, so the tests ported
  from the previous project (`from windows_mt5 import rule_a_engine`) run unchanged.
"""
import importlib
import sys
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

_ALIASED = ("rule_a_engine", "donchian_engine", "donchian_v6_engine", "mt5_time", "mt5_common",
            "rule_a_agent", "donchian_agent", "donchian_v6_agent", "auto_strategies")
_pkg = types.ModuleType("windows_mt5")
_pkg.__path__ = []  # namespace-like; submodules are pre-registered below
sys.modules.setdefault("windows_mt5", _pkg)
for _name in _ALIASED:
    _mod = importlib.import_module(_name)
    setattr(sys.modules["windows_mt5"], _name, _mod)
    sys.modules[f"windows_mt5.{_name}"] = _mod
