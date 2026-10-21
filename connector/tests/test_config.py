"""Config layering: the zip's lifeos_connector.ini is replaced on update; lifeos_connector.local.ini is kept and wins."""
import pytest

from lifeos_connector import VERSION, Config, is_local, parse_symbol_map


def test_local_ini_overrides_download_ini_and_state_dir_is_next_to_it(tmp_path, monkeypatch):
    for k in ("LIFEOS_BASE_URL", "FX_CONNECTOR_TOKEN", "TERMINAL_ID", "MT5_LOGIN", "MT5_SERVER", "TIME_BASIS", "SYMBOL_MAP", "STATE_DIR"):
        monkeypatch.delenv(k, raising=False)
    ini = tmp_path / "lifeos_connector.ini"
    ini.write_text("; header\n[lifeos]\nLIFEOS_BASE_URL=https://x.example/\nFX_CONNECTOR_TOKEN=tok\nTERMINAL_ID=win-home\nTIME_BASIS=xm_europe\n", encoding="utf-8")
    (tmp_path / "lifeos_connector.local.ini").write_text(
        "[lifeos]\nMT5_LOGIN=12345678   ; my account\nMT5_SERVER=XMTrading-MT5 3\nTIME_BASIS=utc\nSYMBOL_MAP=USD_JPY:USDJPY#,EUR/JPY=EURJPY#\n", encoding="utf-8")
    cfg = Config.load(ini)
    assert cfg.base_url == "https://x.example" and cfg.token == "tok" and cfg.terminal_id == "win-home"
    assert cfg.mt5_login == "12345678" and cfg.mt5_server == "XMTrading-MT5 3" and cfg.time_basis == "utc"
    assert cfg.symbol_map == {"USD_JPY": "USDJPY#", "EUR_JPY": "EURJPY#"}
    assert cfg.state_dir == tmp_path / "state" and cfg.version == VERSION == "1.0.0"


def test_bad_values_are_refused():
    with pytest.raises(SystemExit):
        parse_symbol_map("EUR_AUD:EURAUD")
    with pytest.raises(SystemExit):
        parse_symbol_map("garbage")
    assert is_local("http://localhost:5173") and not is_local("https://life-os.example.dev")
