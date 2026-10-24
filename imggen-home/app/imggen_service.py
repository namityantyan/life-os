#!/usr/bin/env python3
"""画像生成サービス imggen-svc（Mac常駐・FastAPI）。

生活支援ボット（別ホスト）から HTTP/JSON で叩かれ、generate.py --json を
subprocess で実行して画像を生成・配信する。安全ガードはサービス側で強制する。

契約は docs/画像生成サービス仕様.md に準拠。
起動: IMGGEN_TOKEN=... tools/.venv/bin/python scripts/imggen_service.py

Life OS 自宅Mac版（life-os/imggen-home/app/）: ai-image-business/scripts/imggen_service.py の複製。
変更はパス（~/LifeOS-imggen 配下・IMGGEN_HOME で変更可）と設定ファイル名（config.env）と、
実写モデルの追加（POST /v1/generate の "model": "anime"（既定）| "photo"、/v1/health の "models"）。
認証・§0 安全ガード・API 契約は元のまま（model を省いた要求は従来どおり anime）。
実写は全年齢のみ（r18 は 422）で、check_photo_prompt_safety も追加で通す。起動は bin/service.zsh（launchd: com.lifeos.imggen-svc）。
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import socket
import sys
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel

# ---- 設定・パス -----------------------------------------------------------

ROOT = Path(os.getenv("IMGGEN_HOME") or Path(__file__).resolve().parent.parent)  # ~/LifeOS-imggen/

try:
    from dotenv import load_dotenv
    load_dotenv(ROOT / "config.env")
except ImportError:
    pass

WORKSPACE = ROOT / "workspace"
GENERATE = Path(__file__).resolve().parent / "generate.py"
VENV_PY = ROOT / "venv" / "bin" / "python"
PY = str(VENV_PY) if VENV_PY.exists() else sys.executable
MODEL_PATH = Path(os.getenv(
    "IMGGEN_MODEL_PATH",
    str(ROOT / "models" / "checkpoints" / "animagine-xl-4.0.safetensors")))
PHOTO_MODEL_PATH = Path(os.getenv(
    "IMGGEN_PHOTO_MODEL_PATH",
    str(ROOT / "models" / "checkpoints" / "RealVisXL_V5.0_fp16.safetensors")))
MODEL_PATHS = {"anime": MODEL_PATH, "photo": PHOTO_MODEL_PATH}
PHOTO_R18_MESSAGE = "実写モデルは全年齢のみです。R18・成人向けの実写は生成できません（アニメを選んでください）。"
COMFY_HOST, COMFY_PORT = "127.0.0.1", 8188

TOKEN = os.getenv("IMGGEN_TOKEN", "")
BIND = os.getenv("IMGGEN_BIND", "127.0.0.1")
PORT = int(os.getenv("IMGGEN_PORT", "8787"))
QUEUE_MAX = int(os.getenv("IMGGEN_QUEUE_MAX", "10"))
JOB_TTL = 3600  # 完了ジョブの保持秒数

NAME_RE = re.compile(r"^[A-Za-z0-9._\-]+$")   # work_id / filename のパストラバーサル対策
RES_RE = re.compile(r"^\d{2,4}x\d{2,4}$")

# safety.py（同ディレクトリ）を流用
sys.path.insert(0, str(Path(__file__).resolve().parent))
from safety import check_prompt_safety, check_photo_prompt_safety  # noqa: E402

app = FastAPI(title="imggen-svc", version="0.1")

_jobs: dict[str, dict] = {}
_queue: asyncio.Queue = asyncio.Queue()


# ---- 認証 -----------------------------------------------------------------

def _auth(authorization: str | None):
    if not TOKEN:
        raise HTTPException(500, "IMGGEN_TOKEN 未設定（サービス設定エラー）")
    if not authorization or not authorization.startswith("Bearer ") or authorization[7:] != TOKEN:
        raise HTTPException(401, "unauthorized")


# ---- ヘルスチェック -------------------------------------------------------

def _comfy_up() -> bool:
    try:
        with socket.create_connection((COMFY_HOST, COMFY_PORT), timeout=1):
            return True
    except OSError:
        return False


def _model_ready(model: str = "anime") -> bool:
    # セットアップは sha256 を確認してから .part を本来の名前に変えるので、ファイルがあれば確認済み。
    path = MODEL_PATHS.get(model)
    try:
        return path is not None and path.exists() and path.stat().st_size > 0
    except OSError:
        return False


@app.get("/v1/health")
def health(authorization: str | None = Header(default=None)):
    _auth(authorization)
    ok = _model_ready()
    body = {
        "ok": ok,
        "comfyui": "up" if _comfy_up() else "down",
        "ssd_mounted": MODEL_PATH.parent.exists(),
        "model_available": _model_ready(),
        "models": {m: _model_ready(m) for m in MODEL_PATHS},
        "queue_length": _queue.qsize(),
    }
    # 既定（anime）モデルが無い＝生成不可。photo の有無は models で返す。
    return Response(content=json.dumps(body, ensure_ascii=False),
                    media_type="application/json",
                    status_code=200 if ok else 503)


# ---- 生成ジョブ -----------------------------------------------------------

class GenReq(BaseModel):
    prompt: str
    count: int = 1
    rating: str = "all_ages"
    model: str = "anime"
    seed: int | None = None
    res: str | None = None
    title: str = ""
    requester: str | None = None


def _prune_jobs():
    now = time.time()
    for jid in [j for j, v in _jobs.items() if v.get("_done_at") and now - v["_done_at"] > JOB_TTL]:
        _jobs.pop(jid, None)


@app.post("/v1/generate")
async def generate(req: GenReq, wait: bool = Query(default=False),
                   authorization: str | None = Header(default=None)):
    _auth(authorization)
    _prune_jobs()

    # パラメータ検証
    if not req.prompt.strip():
        raise HTTPException(422, detail={"error": "bad_request", "message": "prompt が空です"})
    if not (1 <= req.count <= 6):
        raise HTTPException(422, detail={"error": "bad_request", "message": "count は 1〜6"})
    if req.rating not in ("all_ages", "r18"):
        raise HTTPException(422, detail={"error": "bad_request", "message": "rating は all_ages|r18"})
    if req.res and not RES_RE.match(req.res):
        raise HTTPException(422, detail={"error": "bad_request", "message": "res は WxH 形式"})
    if req.model not in MODEL_PATHS:
        raise HTTPException(422, detail={"error": "bad_request", "message": "model は anime|photo"})
    if req.model == "photo" and req.rating != "all_ages":
        raise HTTPException(422, detail={"error": "photo_r18", "message": PHOTO_R18_MESSAGE})

    # §0 安全ガード（サービス側で強制。どのモデルでも同じ）
    ok, msg = check_prompt_safety(req.prompt)
    if not ok:
        raise HTTPException(422, detail={"error": "banned_term", "message": msg})
    if req.model == "photo":
        ok, msg = check_photo_prompt_safety(req.prompt)
        if not ok:
            raise HTTPException(422, detail={"error": "banned_term", "message": msg})

    if _queue.qsize() >= QUEUE_MAX:
        raise HTTPException(503, detail={"error": "unavailable", "message": "キューが一杯です"})
    if not _model_ready(req.model):
        msg = ("実写モデルが入っていません（自宅Macでセットアップをもう一度実行すると追加されます）"
               if req.model == "photo" else "モデル未準備（自宅Macのモデルのダウンロードを確認）")
        raise HTTPException(503, detail={"error": "unavailable", "message": msg})

    job_id = "j_" + uuid.uuid4().hex[:8]
    job = {"job_id": job_id, "status": "queued", "req": req.model_dump(),
           "queue_position": _queue.qsize() + 1, "_done_at": None}
    _jobs[job_id] = job
    await _queue.put(job_id)

    if wait:
        for _ in range(600):  # 最大 ~20分待つ（0.2秒×600 は短すぎ→2秒×600）
            if job["status"] in ("done", "error"):
                return _job_view(job)
            await asyncio.sleep(2)
        raise HTTPException(504, detail={"error": "timeout", "message": "生成がタイムアウト"})

    return Response(content=json.dumps({"job_id": job_id, "status": "queued",
                                        "queue_position": job["queue_position"]}, ensure_ascii=False),
                    media_type="application/json", status_code=202)


def _job_view(job: dict) -> dict:
    v = {"job_id": job["job_id"], "status": job["status"]}
    if job["status"] == "running":
        v.update({"done": job.get("done", 0), "total": job["req"]["count"]})
    elif job["status"] == "done":
        v.update({k: job[k] for k in ("work_id", "rating", "model", "seeds", "prompt", "images") if k in job})
    elif job["status"] == "error":
        v.update({"error": job.get("error", "internal"), "message": job.get("message", "")})
    return v


@app.get("/v1/jobs/{job_id}")
def job_status(job_id: str, authorization: str | None = Header(default=None)):
    _auth(authorization)
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, detail={"error": "not_found", "message": "job が存在しません"})
    return _job_view(job)


@app.get("/v1/images/{work_id}/{filename}")
def get_image(work_id: str, filename: str, authorization: str | None = Header(default=None)):
    _auth(authorization)
    if not NAME_RE.match(work_id) or not NAME_RE.match(filename) or not filename.endswith(".png"):
        raise HTTPException(400, detail={"error": "bad_request", "message": "不正なパス"})
    path = (WORKSPACE / work_id / "raw" / filename).resolve()
    if WORKSPACE.resolve() not in path.parents or not path.exists():
        raise HTTPException(404, detail={"error": "not_found", "message": "画像が存在しません"})
    return Response(content=path.read_bytes(), media_type="image/png")


# ---- ワーカー（FIFO直列） -------------------------------------------------

async def _worker():
    while True:
        job_id = await _queue.get()
        job = _jobs.get(job_id)
        if not job:
            _queue.task_done()
            continue
        job["status"] = "running"
        job["done"] = 0
        r = job["req"]
        cmd = [PY, str(GENERATE), "--json", "--prompt", r["prompt"],
               "--rating", r["rating"], "--count", str(r["count"]),
               "--model", r.get("model") or "anime"]
        if r.get("seed") is not None:
            cmd += ["--seed", str(r["seed"])]
        if r.get("res"):
            cmd += ["--res", r["res"]]
        if r.get("title"):
            cmd += ["--title", r["title"]]
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd, cwd=str(ROOT),
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            out, err = await proc.communicate()
            if proc.returncode != 0:
                job.update(status="error", error="internal",
                           message=(err.decode(errors="replace").strip().splitlines() or ["生成失敗"])[-1])
            else:
                data = json.loads(out.decode().strip().splitlines()[-1])
                images = []
                for i, p in enumerate(data.get("images", [])):
                    fp = Path(p)
                    images.append({
                        "filename": fp.name,
                        "url": f"/v1/images/{data['work_id']}/{fp.name}",
                        "sha256": hashlib.sha256(fp.read_bytes()).hexdigest() if fp.exists() else None,
                        "bytes": fp.stat().st_size if fp.exists() else 0,
                        "seed": data["seeds"][i] if i < len(data.get("seeds", [])) else None,
                    })
                job.update(status="done", work_id=data["work_id"], rating=data["rating"],
                           model=data.get("model", r.get("model") or "anime"),
                           seeds=data.get("seeds", []), prompt=data.get("prompt", ""),
                           images=images, done=len(images))
        except Exception as e:  # noqa: BLE001
            job.update(status="error", error="internal", message=str(e))
        finally:
            job["_done_at"] = time.time()
            _queue.task_done()


@app.on_event("startup")
async def _startup():
    asyncio.create_task(_worker())
    print(f"imggen-svc 起動: http://{BIND}:{PORT}  "
          + "  ".join(f"{m}={'OK' if _model_ready(m) else 'NG'}" for m in MODEL_PATHS))


def main():
    if not TOKEN:
        raise SystemExit("IMGGEN_TOKEN が未設定です。config.env または環境変数で設定してください。")
    import uvicorn
    uvicorn.run(app, host=BIND, port=PORT, log_level="info")


if __name__ == "__main__":
    main()
