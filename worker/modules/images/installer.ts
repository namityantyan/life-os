import { zipWithModes, type ZipFile } from "../../core/zip";
import setupCmd from "../../../imggen-home/LifeOS-画像生成-セットアップ.command?raw";
import statusCmd from "../../../imggen-home/状態確認.command?raw";
import uninstallCmd from "../../../imggen-home/アンインストール.command?raw";
import commonZsh from "../../../imggen-home/lib/common.zsh?raw";
import serviceZsh from "../../../imggen-home/bin/service.zsh?raw";
import tunnelZsh from "../../../imggen-home/bin/tunnel.zsh?raw";
import servicePy from "../../../imggen-home/app/imggen_service.py?raw";
import generatePy from "../../../imggen-home/app/generate.py?raw";
import safetyPy from "../../../imggen-home/app/safety.py?raw";
import serviceReq from "../../../imggen-home/app/requirements-service.txt?raw";
import constraintsTxt from "../../../imggen-home/constraints.txt?raw";
import knownHosts from "../../../imggen-home/known_hosts?raw";

/** 自宅Mac用セットアップ (imggen-home/): the installer files plus this server's secrets, as one zip folder. */
export const HOME_INSTALLER_DIR = "LifeOS-imggen-setup";
export const DEFAULT_TUNNEL_HOST = "rocky@133.167.105.210";
const EXEC = 0o755, SECRET = 0o600;
const FILES: [string, string, number?][] = [
  ["LifeOS-画像生成-セットアップ.command", setupCmd, EXEC], ["状態確認.command", statusCmd, EXEC], ["アンインストール.command", uninstallCmd, EXEC],
  ["lib/common.zsh", commonZsh], ["bin/service.zsh", serviceZsh, EXEC], ["bin/tunnel.zsh", tunnelZsh, EXEC],
  ["app/imggen_service.py", servicePy], ["app/generate.py", generatePy], ["app/safety.py", safetyPy], ["app/requirements-service.txt", serviceReq],
  ["constraints.txt", constraintsTxt], ["known_hosts", knownHosts],
];
const lf = (t: string) => t.replace(/\r\n?/g, "\n");
const TOKEN_RE = /^[A-Za-z0-9._~+/=-]{16,512}$/;
const HOST_RE = /^(?:[a-z_][a-z0-9_.-]{0,31}@)?[A-Za-z0-9.-]{1,253}$/;

/** Validates the secrets and builds the zip. Secrets go only into secrets/ (0600); nothing else contains them. */
export function buildHomeInstaller(s: { token: string; key: string; host?: string | null }): { ok: true; zip: Uint8Array } | { ok: false; message: string } {
  const host = (s.host || DEFAULT_TUNNEL_HOST).trim();
  const key = lf(s.key).trim() + "\n";
  if (!TOKEN_RE.test(s.token)) return { ok: false, message: "IMGGEN_TOKEN の形式が不正です（英数字と ._~+/=- のみ、16文字以上）。" };
  if (!HOST_RE.test(host)) return { ok: false, message: "IMGGEN_TUNNEL_HOST の形式が不正です（例: rocky@133.167.105.210）。" };
  if (!/^-----BEGIN [A-Z ]*PRIVATE KEY-----\n[\s\S]+\n-----END [A-Z ]*PRIVATE KEY-----\n$/.test(key)) return { ok: false, message: "IMGGEN_TUNNEL_KEY の鍵ファイルが秘密鍵の形式ではありません。" };
  const files: Record<string, ZipFile> = Object.fromEntries(FILES.map(([p, src, mode]) => [`${HOME_INSTALLER_DIR}/${p}`, { data: lf(src), mode: mode ?? 0o644 }]));
  files[`${HOME_INSTALLER_DIR}/secrets/secrets.env`] = { mode: SECRET, data: [
    "# Life OS 画像生成の接続設定（ダウンロード時に作成）。セットアップが ~/LifeOS-imggen/config.env に写します。",
    "# 接続用の鍵とトークンが入っています。セットアップが終わったら、このフォルダと zip は削除してください。",
    `IMGGEN_TOKEN='${s.token}'`, `IMGGEN_TUNNEL_HOST='${host}'`, "",
  ].join("\n") };
  files[`${HOME_INSTALLER_DIR}/secrets/tunnel_key`] = { mode: SECRET, data: key };
  return { ok: true, zip: zipWithModes(files) };
}
