#!/bin/zsh
# launchd (com.lifeos.imggen-svc): imggen-svc on 127.0.0.1:IMGGEN_PORT. ComfyUI is started on demand by generate.py.
set -eu
PREFIX="${0:A:h:h}"
set -a; source "$PREFIX/config.env"; set +a
export IMGGEN_HOME="$PREFIX" IMGGEN_BIND=127.0.0.1 IMGGEN_MODEL_PATH="$PREFIX/models/checkpoints/animagine-xl-4.0.safetensors" IMGGEN_PHOTO_MODEL_PATH="$PREFIX/models/checkpoints/RealVisXL_V5.0_fp16.safetensors"
export PYTORCH_ENABLE_MPS_FALLBACK=1 PYTHONUNBUFFERED=1 PATH=/usr/bin:/bin:/usr/sbin:/sbin
cd "$PREFIX"
exec "$PREFIX/venv/bin/python" "$PREFIX/app/imggen_service.py"
