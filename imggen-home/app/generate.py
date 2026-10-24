#!/usr/bin/env python3
"""
generate.py — 生成〜証跡記録を一気通貫で行うツール

ComfyUI(127.0.0.1:8188) を叩いて画像を生成し、
  workspace/<work-id>/{raw,edited,masked,final,psd}/ を自動作成
  raw/ に画像を保存
  meta.json（CLAUDE.md §5 スキーマ）を自動記録  ← 著作権の証跡
  logs/generation.jsonl に追記
までを自動化する。ComfyUI が起動していなければ自動起動する。

重要（CLAUDE.md）:
  - これは「生成の補助」であり、②加筆修正(edited/)は人手で必須。
    加筆しないと著作権が発生しない可能性が高い（§4）。precheck は edited/ が
    空だと fail する。
  - R-18 で「未成年に見えないか」の最終判断は人間の必須工程（§0-1・§6）。
    本スクリプトは r18 プリセットで未成年回避のネガティブを既定にするが、
    それは補助にすぎず、等倍目視の最終確認を省略しないこと。

使い方:
    # 全年齢を1枚（既定プリセット: pinup）
    python scripts/generate.py --prompt "1girl, ..." --rating all_ages

    # 縦ピンナップを4枚、seedはランダム
    python scripts/generate.py --prompt "..." --count 4 --res 896x1152

    # work-id を指定（省略時は当月の wNN を自動採番）
    python scripts/generate.py --prompt "..." --work-id 2026-08-w01 --title "夏の光"

    # seed 固定（再現性の確認）
    python scripts/generate.py --prompt "..." --seed 12345

Life OS 自宅Mac版（life-os/imggen-home/app/）: ai-image-business/scripts/generate.py の複製。
変更はパス（~/LifeOS-imggen 配下・IMGGEN_HOME で変更可）、ComfyUI のログ出力先、
記号の表記だけ。プロンプト組み立て・未成年回避ネガティブ・meta.json 証跡は元のまま。
"""
from __future__ import annotations

import argparse
import json
import os
import random
import re
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

PROJECT_ROOT = Path(os.getenv("IMGGEN_HOME") or Path(__file__).resolve().parent.parent)
WORKSPACE = PROJECT_ROOT / "workspace"
LOGS = PROJECT_ROOT / "logs"
COMFY_DIR = PROJECT_ROOT / "ComfyUI"
VENV_PY = PROJECT_ROOT / "venv" / "bin" / "python"
RUN_SH = COMFY_DIR / "main.py"
API = "http://127.0.0.1:8188"

# 主力モデル（docs/作風決定.md）。ホワイトリスト・販売可を一次確認済み。
MODEL = {
    "name": "Animagine XL 4.0",
    "ckpt_file": "animagine-xl-4.0.safetensors",
    "version": "4.0",
    "license": "openrail++ (CreativeML Open RAIL++-M)",
    "commercial_ok": True,
}

# 作風プリセット。品質タグ・ネガティブ・サンプラ設定をまとめる。
# 「鮮やかセル調ピンナップ」を既定とする（docs/作風決定.md）。
QUALITY_TAGS = "masterpiece, high score, great quality, absurdres"
BASE_NEGATIVE = (
    "lowres, bad anatomy, bad hands, text, error, missing finger, extra digits, "
    "fewer digits, cropped, worst quality, low quality, low score, bad score, "
    "average score, signature, watermark, username, blurry, artist name"
)
# R-18 での未成年回避ネガティブ（補助。最終判断は人間）。
MINOR_AVOID_NEGATIVE = "child, loli, shota, toddler, infant, baby, underage, kindergarten"

PRESETS = {
    "pinup": {
        "desc": "鮮やかセル調ピンナップ（既定）",
        "steps": 28,
        "cfg": 5.0,
        "sampler": "euler_ancestral",
        "scheduler": "normal",
        "res": "896x1152",
        "quality": QUALITY_TAGS,
        "negative": BASE_NEGATIVE,
    },
}


JSON_MODE = False


def log(msg: str) -> None:
    # --json のときは人向けログを stderr に逃がし、stdout を純粋なJSONにする。
    print(msg, file=sys.stderr if JSON_MODE else sys.stdout, flush=True)


# ---- ComfyUI サーバ管理 --------------------------------------------------
def server_alive() -> bool:
    try:
        urllib.request.urlopen(API + "/system_stats", timeout=5)
        return True
    except Exception:
        return False


def ensure_server() -> subprocess.Popen | None:
    """ComfyUI が起きていなければ自動起動して待つ。起動したら Popen を返す。"""
    if server_alive():
        log("- ComfyUI は起動済み")
        return None
    if not RUN_SH.exists():
        sys.exit("ComfyUI が見つかりません。先に LifeOS-画像生成-セットアップ.command を実行してください。")
    log("- ComfyUI を起動します…")
    LOGS.mkdir(exist_ok=True)
    comfy_log = (LOGS / "comfyui.log").open("ab")
    proc = subprocess.Popen(
        [str(VENV_PY), "main.py", "--listen", "127.0.0.1", "--port", "8188"],
        cwd=str(COMFY_DIR),
        env={**os.environ, "PYTORCH_ENABLE_MPS_FALLBACK": "1"},
        stdout=comfy_log, stderr=subprocess.STDOUT,
    )
    for _ in range(90):
        if server_alive():
            log("- ComfyUI READY")
            return proc
        if proc.poll() is not None:
            sys.exit("ComfyUI の起動に失敗しました。~/LifeOS-imggen/logs/comfyui.log を確認してください。")
        time.sleep(2)
    sys.exit("ComfyUI が時間内に起動しませんでした。")


def check_model_available() -> None:
    oi = _get(f"/object_info/CheckpointLoaderSimple")
    ckpts = oi["CheckpointLoaderSimple"]["input"]["required"]["ckpt_name"][0]
    if MODEL["ckpt_file"] not in ckpts:
        sys.exit(
            f"モデル {MODEL['ckpt_file']} が見つかりません。\n"
            f"  認識されているモデル: {ckpts}\n"
            f"  ~/LifeOS-imggen/models/checkpoints/ にダウンロードできているか確認してください。"
        )


# ---- HTTP ヘルパ ---------------------------------------------------------
def _get(path: str):
    with urllib.request.urlopen(API + path, timeout=15) as r:
        return json.load(r)


def _post(path: str, payload: dict):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        API + path, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


# ---- ワークスペース ------------------------------------------------------
def next_work_id() -> str:
    """当月の 'YYYY-MM-wNN' を自動採番（既存を避けて連番）。"""
    ym = datetime.now().strftime("%Y-%m")
    n = 1
    while (WORKSPACE / f"{ym}-w{n:02d}").exists():
        n += 1
    return f"{ym}-w{n:02d}"


def make_workspace(work_id: str) -> Path:
    d = WORKSPACE / work_id
    for sub in ("raw", "edited", "masked", "final", "psd"):
        (d / sub).mkdir(parents=True, exist_ok=True)
    return d


# ---- グラフ構築 ----------------------------------------------------------
def build_graph(prompt: str, negative: str, seed: int, preset: dict,
                width: int, height: int) -> dict:
    return {
        "4": {"class_type": "CheckpointLoaderSimple",
              "inputs": {"ckpt_name": MODEL["ckpt_file"]}},
        "5": {"class_type": "EmptyLatentImage",
              "inputs": {"width": width, "height": height, "batch_size": 1}},
        "6": {"class_type": "CLIPTextEncode",
              "inputs": {"text": prompt, "clip": ["4", 1]}},
        "7": {"class_type": "CLIPTextEncode",
              "inputs": {"text": negative, "clip": ["4", 1]}},
        "3": {"class_type": "KSampler",
              "inputs": {"seed": seed, "steps": preset["steps"], "cfg": preset["cfg"],
                         "sampler_name": preset["sampler"], "scheduler": preset["scheduler"],
                         "denoise": 1.0, "model": ["4", 0], "positive": ["6", 0],
                         "negative": ["7", 0], "latent_image": ["5", 0]}},
        "8": {"class_type": "VAEDecode",
              "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
        "9": {"class_type": "SaveImage",
              "inputs": {"filename_prefix": "gen", "images": ["8", 0]}},
    }


def run_one(graph: dict, timeout_s: int = 360) -> list[dict]:
    """1グラフを実行し、SaveImage の出力画像メタ(list)を返す。"""
    pid = _post("/prompt", {"prompt": graph})["prompt_id"]
    for _ in range(timeout_s // 2):
        hist = _get(f"/history/{pid}")
        if pid in hist and hist[pid].get("status", {}).get("completed"):
            outs = hist[pid].get("outputs", {})
            imgs = []
            for node in outs.values():
                imgs.extend(node.get("images", []))
            return imgs
        time.sleep(2)
    raise TimeoutError("生成がタイムアウトしました")


def collect_output(img_meta: dict) -> Path:
    sub = img_meta.get("subfolder", "")
    return COMFY_DIR / "output" / sub / img_meta["filename"]


# ---- meta.json / ログ ----------------------------------------------------
def write_meta(work_dir: Path, work_id: str, title: str, rating: str,
               prompt: str, negative: str, seeds: list[int], preset: dict,
               width: int, height: int, count: int) -> None:
    meta = {
        "work_id": work_id,
        "title": title,
        "rating": rating,
        "model": {
            "name": MODEL["name"],
            "version": MODEL["version"],
            "license": MODEL["license"],
            "commercial_ok": MODEL["commercial_ok"],
        },
        "loras": [],
        "generation": {
            "prompt": prompt,
            "negative_prompt": negative,
            "seed": seeds[0] if seeds else None,
            "seeds": seeds,
            "steps": preset["steps"],
            "cfg": preset["cfg"],
            "sampler": f"{preset['sampler']}_{preset['scheduler']}",
            "resolution": f"{width}x{height}",
            "iterations": count,
        },
        "editing": {
            "edited": False,
            "tool": "",
            "psd_path": "",
            "description": "",
        },
        "mosaic": {
            "applied": False, "block_px": None, "min_ratio": 0.01,
            "verified_at_100pct": False,
        },
        "declarations": {
            "ai_generated": True,
            "dlsite_category": "AI生成作品",
            "fanza_tier": "AI生成",
            "characters_18plus": (rating == "r18") or None,
            "real_person_reference": False,
            "existing_ip_reference": False,
        },
    }
    (work_dir / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def append_gen_log(entries: list[dict]) -> None:
    LOGS.mkdir(exist_ok=True)
    with (LOGS / "generation.jsonl").open("a", encoding="utf-8") as f:
        for e in entries:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")


# ---- メイン --------------------------------------------------------------
def main() -> None:
    ap = argparse.ArgumentParser(description="生成〜証跡記録を一気通貫で行う")
    ap.add_argument("--prompt", required=True, help="ポジティブプロンプト（英語タグ）")
    ap.add_argument("--negative", default=None, help="追加ネガティブ（プリセットに追記）")
    ap.add_argument("--preset", default="pinup", choices=list(PRESETS))
    ap.add_argument("--rating", default="all_ages", choices=["all_ages", "r18"])
    ap.add_argument("--count", type=int, default=1, help="生成枚数")
    ap.add_argument("--seed", type=int, default=None, help="固定seed（省略でランダム）")
    ap.add_argument("--res", default=None, help="解像度 WxH（省略でプリセット既定）")
    ap.add_argument("--work-id", default=None, help="省略で当月wNNを自動採番")
    ap.add_argument("--title", default="", help="作品タイトル")
    ap.add_argument("--no-autostart", action="store_true",
                    help="ComfyUIを自動起動しない")
    ap.add_argument("--json", action="store_true",
                    help="結果をJSONでstdoutに出力（人向けログはstderrへ）。Bot連携用")
    args = ap.parse_args()

    global JSON_MODE
    JSON_MODE = args.json

    preset = PRESETS[args.preset]
    res = args.res or preset["res"]
    m = re.fullmatch(r"(\d+)x(\d+)", res)
    if not m:
        sys.exit(f"--res の形式が不正です: {res}（例: 896x1152）")
    width, height = int(m.group(1)), int(m.group(2))

    # プロンプト組み立て
    #
    # Animagine XL 4.0 の rating tag を Positive 側にも明示する。
    #   all_ages -> safe
    #   r18      -> explicit
    #
    # 品質タグはスクリプト側で自動付与するため、ユーザー側で毎回書く必要はない。
    user_prompt = args.prompt.strip().rstrip(",")
    rating_tag = "explicit" if args.rating == "r18" else "safe"
    full_prompt = f"{user_prompt}, {rating_tag}, {preset['quality']}"

    negative = preset["negative"]
    if args.rating == "r18":
        # R-18 は未成年表現を避ける語を既定で追加。
        negative = f"{MINOR_AVOID_NEGATIVE}, {negative}"
    else:
        # 全年齢では NSFW を明示的に避ける。
        negative = f"nsfw, explicit, {negative}"

    # --negative は既定ネガティブを置き換えず、末尾に追記する。
    if args.negative:
        negative = f"{negative}, {args.negative.strip().rstrip(',')}"

    work_id = args.work_id or next_work_id()
    work_dir = make_workspace(work_id)

    proc = None if args.no_autostart else ensure_server()
    if not server_alive():
        sys.exit("ComfyUI に接続できません。--no-autostart を外すか手動起動してください。")

    try:
        check_model_available()
        log(f"- work_id: {work_id}  rating: {args.rating}  preset: {args.preset}")
        log(f"- {width}x{height} / {preset['steps']}steps / cfg {preset['cfg']} / {preset['sampler']}")

        raw_dir = work_dir / "raw"
        existing = len(list(raw_dir.glob("*.png")))
        seeds: list[int] = []
        produced: list[str] = []
        gen_entries: list[dict] = []

        for i in range(args.count):
            seed = args.seed if args.seed is not None else random.randint(0, 2**31 - 1)
            seeds.append(seed)
            graph = build_graph(full_prompt, negative, seed, preset, width, height)
            t0 = time.time()
            imgs = run_one(graph)
            dt = time.time() - t0
            for j, im in enumerate(imgs):
                src = collect_output(im)
                idx = existing + i + 1
                dst = raw_dir / f"{idx:02d}_seed{seed}.png"
                shutil.copy2(src, dst)
                produced.append(str(dst))
                log(f"  OK raw/{dst.name}  seed={seed}  {dt:.1f}s")
                gen_entries.append({
                    "ts": datetime.now(timezone.utc).isoformat(),
                    "work_id": work_id, "file": f"raw/{dst.name}",
                    "model": MODEL["name"], "seed": seed,
                    "prompt": full_prompt, "negative": negative,
                    "resolution": f"{width}x{height}", "steps": preset["steps"],
                    "cfg": preset["cfg"], "sampler": preset["sampler"],
                    "rating": args.rating, "seconds": round(dt, 1),
                })

        write_meta(work_dir, work_id, args.title, args.rating,
                   full_prompt, negative, seeds, preset, width, height, args.count)
        append_gen_log(gen_entries)

        if args.json:
            print(json.dumps({
                "ok": True, "work_id": work_id, "rating": args.rating,
                "images": produced, "seeds": seeds, "count": len(produced),
                "prompt": full_prompt, "negative": negative,
            }, ensure_ascii=False), flush=True)

        log("")
        log(f"完了: workspace/{work_id}/raw/ に {args.count} 枚、meta.json を記録")
        log("次の工程（必須）:")
        log("  ② 加筆修正 → edited/ に保存、psd/ に作業ファイル（著作権の証跡）")
        if args.rating == "r18":
            log("  ③ モザイク → scripts/mosaic.py（等倍で目視確認）")
            log("  注意: 未成年に見えないかの最終判断は人手で必ず行うこと")
        log("  ④ 検査 → python scripts/precheck.py workspace/%s" % work_id)
    finally:
        # 自動起動したサーバは起動したまま残す（次の生成が速いため）。
        if proc is not None:
            log("")
            log("※ ComfyUI は起動したままです。止めるには: pkill -f 'ComfyUI/main.py'")


if __name__ == "__main__":
    main()
