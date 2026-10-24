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
# 実写はディープフェイクの危険が大きいので、実在人物の指定はどの区分でも厳しめに弾く。
# 全年齢は性的な語を弾く。R18 は大人だけ: 年齢・学生・学校・幼さを示す語と 20 歳未満の年齢を弾く
# （"girl" / "boy" は弾かず、generate.py が "woman" / "man" に書き換える）。
# Life OS 側（worker/modules/images/logic.ts。キーワード＋AI 判定）と同じ方針の第一次フィルタ。最終判断は人間。
PHOTO_SEXUAL_TERMS = [
    "nsfw", "nude", "naked", "sex", "sexy", "explicit", "lewd", "ecchi", "hentai", "porn", "nipples",
    "pussy", "penis", "erotic", "topless", "bottomless", "lingerie", "underwear only", "r18", "r-18",
    "18禁", "成人向け", "エロ", "全裸", "半裸", "ヌード", "セックス", "性的", "下着姿",
]
PHOTO_REAL_PERSON_TERMS = [
    "celebrity", "celebrities", "famous person", "famous actor", "famous actress", "actor", "actress",
    "politician", "president", "prime minister", "royal family", "influencer", "youtuber", "streamer",
    "idol", "lookalike", "look-alike", "looks like", "deepfake", "deep fake", "face swap", "faceswap",
    "real person", "芸能人", "有名人", "俳優", "女優", "政治家", "首相", "総理", "大統領", "皇室", "王室",
    "アイドル", "配信者", "ユーチューバー", "インフルエンサー", "そっくり", "似せて", "に似た", "実在の",
    "知人", "友達の顔", "元カノ", "元カレ", "ディープフェイク",
]
# 実写 R18 で弾く語（logic.ts PHOTO_R18_YOUTH_TERMS と同じ）。BANNED_PROMPT_TERMS も別に必ず通す。
PHOTO_R18_YOUTH_TERMS = [
    "teen", "teens", "teenage", "teenager", "teenagers", "adolescent", "adolescence", "juvenile", "minor", "minors",
    "underage", "under age", "jailbait", "child", "children", "childish", "kid", "kids", "young girl", "young boy",
    "young-looking", "young looking", "youthful", "youthful face", "baby face", "babyface", "baby-faced",
    "schoolgirl", "schoolgirls", "schoolboy", "schoolboys", "school girl", "school boy", "student", "students",
    "pupil", "school", "high school", "highschool", "high schooler", "middle school", "junior high",
    "school uniform", "school swimsuit", "sailor uniform", "sailor suit", "serafuku", "gym uniform", "bloomers",
    "randoseru", "lolita", "petite", "tiny", "small body", "flat chest", "flat chested", "flat-chested",
    "aged down", "jk", "jc", "js", "dk",
    "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
    "少女", "少年", "女子高生", "女子中学生", "女子小学生", "男子高校生", "男子中学生", "高校生", "中学生", "小学生",
    "学生", "生徒", "女学生", "制服", "セーラー服", "ブレザー", "体操服", "ブルマ", "スク水", "スクール水着",
    "ランドセル", "学校", "放課後", "ロリ", "ショタ", "幼い", "幼く", "幼げ", "幼顔", "幼児体型", "童顔",
    "若く見える", "若く見せ", "若い見た目", "あどけな", "小柄", "子供", "子ども", "こども", "未成年",
    "10代", "十代", "ティーン",
]
# 20 歳未満の年齢の指定（"17歳" "16 years old" "15yo"）。
UNDER_20_AGE_RE = re.compile(r"(^|[^0-9])1?[0-9]\s*(歳|才|yo\b|y/o|years?[ -]old|year-old)")
PHOTO_R18_YOUTH_MESSAGE = "実写のR18は大人（成人）だけです。年齢・学生・制服・幼さを示す言葉は使えません。"
_YOUTH_REASON = PHOTO_R18_YOUTH_MESSAGE.rstrip("。")


def _has(low: str, term: str) -> bool:
    """ASCII の語は単語境界で（"actor" が "factor" に当たらないように）、日本語は部分一致で。"""
    if term.isascii():
        esc = re.escape(term).replace(r"\ ", "[ _]")
        return re.search(rf"(^|[^a-z0-9]){esc}($|[^a-z0-9])", low) is not None
    return term in low


def check_photo_prompt_safety(prompt: str, rating: str = "all_ages") -> tuple[bool, str]:
    """実写モデル用の追加チェック。check_prompt_safety と併用する。(ok, message)。
    実在人物はどの区分でも不可。all_ages は性的な語が不可、r18 は年齢・学生・幼さを示す語が不可。"""
    low = unicodedata.normalize("NFKC", prompt).lower()
    for t in PHOTO_REAL_PERSON_TERMS:
        if _has(low, t):
            return False, f"禁止語『{t}』を含みます（実写では実在の人物・実在の人物に似せた画像は不可）。"
    if rating == "r18":
        for t in PHOTO_R18_YOUTH_TERMS:
            if _has(low, t):
                return False, f"禁止語『{t}』を含みます（{_YOUTH_REASON}）。"
        m = UNDER_20_AGE_RE.search(low)
        if m:
            return False, f"20歳未満の年齢『{m.group(0)[len(m.group(1)):].strip()}』を含みます（{_YOUTH_REASON}）。"
    else:
        for t in PHOTO_SEXUAL_TERMS:
            if _has(low, t):
                return False, f"禁止語『{t}』を含みます（実写の全年齢では性的な表現は不可。成人向けは R18 を選ぶ）。"
    return True, ""
