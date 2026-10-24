"""§0 安全ガード（共通モジュール）。

未成年想起語・既存キャラ/作家名・実在人物名を positive プロンプトから機械的に弾く。
discord_bot.py / imggen_service.py の双方から流用する（CLAUDE.md §0）。
※ 最終判断（未成年に見えないか等）は人間が行う。ここは第一次の機械フィルタ。
"""
from __future__ import annotations

# 未成年を想起させる語（positive に入った時点で拒否）
BANNED_PROMPT_TERMS = [
    "loli", "shota", "toddler", "infant", "childlike", "child porn", "cp,",
    "underage", "preteen", "pre-teen", "little girl", "little boy", "young child",
    "elementary", "kindergarten", "幼女", "幼児", "小学生", "園児", "ロリ", "ショタ",
]

# 実在人物・既存キャラ/作家名。機械的網羅は困難なので注意喚起にとどめ、
# 個別ブロックが必要な固有名はここに追記する（最終判断は人間・§0）。
BANNED_NAME_TERMS: list[str] = []


def check_prompt_safety(prompt: str) -> tuple[bool, str]:
    """(ok, message) を返す。ok=False のとき message に理由。"""
    low = prompt.lower()
    for t in BANNED_PROMPT_TERMS:
        if t in low:
            return False, f"禁止語『{t}』を含みます（§0: 未成年表現は不可）。"
    for t in BANNED_NAME_TERMS:
        if t.lower() in low:
            return False, f"禁止語『{t}』を含みます（§0: 既存キャラ・実在人物は不可）。"
    return True, ""
