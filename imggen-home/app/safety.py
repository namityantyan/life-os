"""§0 安全ガード（共通モジュール）。

未成年想起語・既存キャラ/作家名・実在人物名を positive プロンプトから機械的に弾く。
discord_bot.py / imggen_service.py の双方から流用する（CLAUDE.md §0）。
※ 最終判断（未成年に見えないか等）は人間が行う。ここは第一次の機械フィルタ。
"""
from __future__ import annotations

import re
import unicodedata

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


# ---- 実写モデル（photo）専用（Life OS 自宅Mac版で追加） -----------------------
# 実写はディープフェイクの危険が大きいので、全年齢のみ・実在人物の指定は厳しめに弾く。
# Life OS 側（キーワード＋AI 判定）と同じ方針の第一次フィルタ。最終判断は人間。
PHOTO_SEXUAL_TERMS = [
    "nsfw", "nude", "naked", "sex", "sexy", "explicit", "lewd", "ecchi", "hentai", "porn", "nipples",
    "pussy", "penis", "erotic", "topless", "bottomless", "lingerie", "underwear only", "r18", "r-18",
    "18禁", "成人向け", "エロ", "全裸", "半裸", "ヌード", "セックス", "性的", "下着姿",
]
PHOTO_REAL_PERSON_TERMS = [
    "celebrity", "celebrities", "famous person", "famous actor", "famous actress", "actor", "actress",
    "politician", "president", "prime minister", "royal family", "influencer", "youtuber", "streamer",
    "idol", "lookalike", "look-alike", "looks like", "deepfake", "deep fake", "face swap", "faceswap",
    "real person", "芸能人", "有名人", "俳優", "女優", "政治家", "首相", "大統領", "アイドル", "配信者",
    "そっくり", "似せて", "ディープフェイク",
]


def _has(low: str, term: str) -> bool:
    """ASCII の語は単語境界で（"actor" が "factor" に当たらないように）、日本語は部分一致で。"""
    if term.isascii():
        esc = re.escape(term).replace(r"\ ", "[ _]")
        return re.search(rf"(^|[^a-z0-9]){esc}($|[^a-z0-9])", low) is not None
    return term in low


def check_photo_prompt_safety(prompt: str) -> tuple[bool, str]:
    """実写モデル用の追加チェック。check_prompt_safety と併用する。(ok, message)。"""
    low = unicodedata.normalize("NFKC", prompt).lower()
    for t in PHOTO_SEXUAL_TERMS:
        if _has(low, t):
            return False, f"禁止語『{t}』を含みます（実写モデルは全年齢のみ）。"
    for t in PHOTO_REAL_PERSON_TERMS:
        if _has(low, t):
            return False, f"禁止語『{t}』を含みます（実写では実在の人物・実在の人物に似せた画像は不可）。"
    return True, ""
