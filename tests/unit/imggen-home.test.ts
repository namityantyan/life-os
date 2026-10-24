import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { unzipSync, strFromU8 } from "fflate";
import { Hono } from "hono";
import type { AppEnv, Env } from "../../worker/env";
import { routes } from "../../worker/modules/images/routes";
import { buildHomeInstaller, HOME_INSTALLER_DIR } from "../../worker/modules/images/installer";
import { zipWithModes } from "../../worker/core/zip";

const TOKEN = "tok_0123456789abcdef0123456789abcdef";
const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\r\nb3BlbnNzaC1rZXktdjEAAAAAc2VjcmV0LWtleS1ib2R5\r\n-----END OPENSSH PRIVATE KEY-----";
const KEY_BODY = "b3BlbnNzaC1rZXktdjEAAAAAc2VjcmV0LWtleS1ib2R5";
const D = HOME_INSTALLER_DIR;

/** Central-directory entries of a zip: name, "made by" OS, UTF-8 flag and Unix mode. */
function centralDirectory(zip: Uint8Array) {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = zip.length - 22;
  while (eocd >= 0 && v.getUint32(eocd, true) !== 0x06054b50) eocd--;
  const n = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out: { name: string; os: number; utf8: boolean; mode: number }[] = [];
  for (let i = 0; i < n; i++) {
    expect(v.getUint32(p, true)).toBe(0x02014b50);
    const nameLen = v.getUint16(p + 28, true), extraLen = v.getUint16(p + 30, true), commentLen = v.getUint16(p + 32, true);
    out.push({ name: new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen)), os: v.getUint8(p + 5), utf8: (v.getUint16(p + 8, true) & 0x800) !== 0, mode: v.getUint32(p + 38, true) >>> 16 });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function build(host?: string) {
  const r = buildHomeInstaller({ token: TOKEN, key: KEY, host });
  if (!r.ok) throw new Error(r.message);
  return r.zip;
}

describe("home-Mac installer zip", () => {
  it("contains the installer, vendored service and secrets under one folder", () => {
    const names = Object.keys(unzipSync(build())).sort();
    expect(names).toEqual([
      "LifeOS-画像生成-セットアップ.command", "app/generate.py", "app/imggen_service.py", "app/requirements-service.txt", "app/safety.py",
      "bin/service.zsh", "bin/tunnel.zsh", "constraints.txt", "known_hosts", "lib/common.zsh", "secrets/secrets.env", "secrets/tunnel_key",
      "アンインストール.command", "状態確認.command",
    ].map((n) => `${D}/${n}`).sort());
  });

  it("keeps .command and bin scripts executable, secrets owner-only, names UTF-8", () => {
    const cd = centralDirectory(build());
    const mode = (n: string) => cd.find((e) => e.name === `${D}/${n}`)!.mode;
    for (const e of cd) { expect(e.os).toBe(3); expect(e.mode & 0o170000).toBe(0o100000); }
    for (const n of ["LifeOS-画像生成-セットアップ.command", "状態確認.command", "アンインストール.command", "bin/service.zsh", "bin/tunnel.zsh"]) expect(mode(n) & 0o777).toBe(0o755);
    for (const n of ["secrets/secrets.env", "secrets/tunnel_key"]) expect(mode(n) & 0o777).toBe(0o600);
    for (const n of ["lib/common.zsh", "app/imggen_service.py", "known_hosts"]) expect(mode(n) & 0o777).toBe(0o644);
    expect(cd.find((e) => e.name.includes("セットアップ"))!.utf8).toBe(true);
  });

  it("has LF line endings everywhere and zsh shebangs on the scripts", () => {
    const files = unzipSync(build());
    for (const [name, data] of Object.entries(files)) expect(strFromU8(data).includes("\r"), name).toBe(false);
    for (const n of ["LifeOS-画像生成-セットアップ.command", "状態確認.command", "アンインストール.command", "bin/service.zsh", "bin/tunnel.zsh"]) expect(strFromU8(files[`${D}/${n}`]!).startsWith("#!/bin/zsh\n")).toBe(true);
  });

  it("puts the token, host and key only into secrets/", () => {
    const files = unzipSync(build("deploy@example.net"));
    for (const [name, data] of Object.entries(files)) {
      const t = strFromU8(data);
      expect(t.includes(TOKEN), name).toBe(name === `${D}/secrets/secrets.env`);
      expect(t.includes(KEY_BODY), name).toBe(name === `${D}/secrets/tunnel_key`);
      expect(t.includes("deploy@example.net"), name).toBe(name === `${D}/secrets/secrets.env`);
    }
    const env = strFromU8(files[`${D}/secrets/secrets.env`]!);
    expect(env).toContain(`IMGGEN_TOKEN='${TOKEN}'\n`);
    expect(env).toContain(`IMGGEN_TUNNEL_HOST='deploy@example.net'\n`);
    expect(strFromU8(files[`${D}/secrets/tunnel_key`]!)).toBe(`-----BEGIN OPENSSH PRIVATE KEY-----\n${KEY_BODY}\n-----END OPENSSH PRIVATE KEY-----\n`);
    expect(strFromU8(unzipSync(build())[`${D}/secrets/secrets.env`]!)).toContain("IMGGEN_TUNNEL_HOST='rocky@133.167.105.210'");
  });

  it("refuses malformed secrets instead of writing them into a shell-sourced file", () => {
    expect(buildHomeInstaller({ token: "abc'; rm -rf ~ #0123456789", key: KEY }).ok).toBe(false);
    expect(buildHomeInstaller({ token: "short", key: KEY }).ok).toBe(false);
    expect(buildHomeInstaller({ token: TOKEN, key: KEY, host: "rocky@host; touch /tmp/x" }).ok).toBe(false);
    expect(buildHomeInstaller({ token: TOKEN, key: "ssh-ed25519 AAAA public key" }).ok).toBe(false);
  });

  it("zipWithModes defaults to 0644", () => {
    expect(centralDirectory(zipWithModes({ "a.txt": { data: "x" } }))[0]!.mode & 0o777).toBe(0o644);
  });
});

describe("imggen-home sources", () => {
  const root = join(__dirname, "../../imggen-home");
  const walk = (d: string): string[] => readdirSync(d).filter((f) => f !== "__pycache__").flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
  it("have no CRLF, no emoji/pictographs, and the service keeps the safety guard", () => {
    for (const f of walk(root)) {
      const t = readFileSync(f, "utf8");
      expect(t.includes("\r"), f).toBe(false);
      expect(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}▶▸]/u.test(t), f).toBe(false);
    }
    const svc = readFileSync(join(root, "app/imggen_service.py"), "utf8");
    expect(svc).toContain("from safety import check_prompt_safety");
    expect(svc).toContain("ok, msg = check_prompt_safety(req.prompt)");
    expect(readFileSync(join(root, "app/generate.py"), "utf8")).toContain("MINOR_AVOID_NEGATIVE = \"child, loli, shota");
  });

  it("add the photo model: pinned download, adult-only r18, safety on both models, upgrade-in-place setup", () => {
    const rd = (p: string) => readFileSync(join(root, p), "utf8");
    const common = rd("lib/common.zsh");
    expect(common).toContain("PHOTO_MODEL_URL=\"${LIFEOS_IMGGEN_PHOTO_MODEL_URL:-https://huggingface.co/SG161222/RealVisXL_V5.0/resolve/ac93e0dda1f6d448cae19bbfab8c5e720a5e48bc/RealVisXL_V5.0_fp16.safetensors}\"");
    expect(common).toContain("PHOTO_MODEL_SIZE=\"${LIFEOS_IMGGEN_PHOTO_MODEL_SIZE:-6938065488}\"");
    expect(common).toContain("PHOTO_MODEL_SHA256=\"${LIFEOS_IMGGEN_PHOTO_MODEL_SHA256:-6a35a7855770ae9820a3c931d4964c3817b6d9e3c6f9c4dabb5b3a94e5643b80}\"");
    expect(common).toMatch(/for i in \{1\.\.30\}; do agent_loaded "\$1" \|\| return 0; sleep 0\.5; done/); // agent_stop waits for bootout
    const gen = rd("app/generate.py");
    expect(gen).toContain("\"ckpt_file\": \"RealVisXL_V5.0_fp16.safetensors\"");
    expect(gen).toContain("PHOTO_SAFETY_NEGATIVE = f\"nsfw, nude, naked, explicit, sexual, cleavage, underwear, lingerie, {MINOR_AVOID_NEGATIVE}\"");
    expect(gen).toMatch(/"sampler": "dpmpp_sde",\s+"scheduler": "karras"/);
    expect(gen).toContain("ap.add_argument(\"--model\", default=\"anime\"");
    const svc = rd("app/imggen_service.py");
    expect(svc).toContain("model: str = \"anime\"");
    expect(svc).not.toContain("PHOTO_R18_MESSAGE");
    expect(svc).toContain("ok, msg = check_photo_prompt_safety(req.prompt, req.rating)");
    expect(gen).toContain("check_photo_prompt_safety(args.prompt, args.rating)");
    expect(svc).toContain("\"models\": {m: _model_ready(m) for m in MODEL_PATHS}");
    expect(rd("bin/service.zsh")).toContain("IMGGEN_PHOTO_MODEL_PATH=\"$PREFIX/models/checkpoints/RealVisXL_V5.0_fp16.safetensors\"");
    const setup = rd("LifeOS-画像生成-セットアップ.command");
    expect(setup).toContain("download_model \"$photo_dest\" \"$PHOTO_MODEL_URL\" \"$PHOTO_MODEL_SIZE\" \"$PHOTO_MODEL_SHA256\"");
    expect(setup).toContain("内蔵ディスクの空きが足りないため、実写モデルは入れませんでした");
    expect(setup).toContain("更新するときは、Life OS から新しい zip をダウンロードしてこのセットアップをもう一度実行してください。");
    const status = rd("状態確認.command");
    expect(status).toContain("model_state \"$MODEL_FILE\"");
    expect(status).toContain("model_state \"$PHOTO_MODEL_FILE\"");
  });
});

describe("GET /api/images/home-installer", () => {
  const mk = (env: Partial<Env>) => {
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => { c.set("user", { id: "u1", email: "a@b", name: null, picture: null }); await next(); });
    app.route("/api/images", routes);
    return app.request("/api/images/home-installer", {}, env as Env);
  };
  const files = (paths: Record<string, string>) => ({ read: async (p: string) => { if (p in paths) return paths[p]!; throw new Error("ENOENT"); } });

  it("returns the zip when token and key file are configured", async () => {
    const r = await mk({ IMGGEN_TOKEN: TOKEN, IMGGEN_TUNNEL_KEY: "/k", LOCAL_FILES: files({ "/k": KEY }) });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/zip");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("content-disposition")).toContain("lifeos-imggen-setup.zip");
    const z = unzipSync(new Uint8Array(await r.arrayBuffer()));
    expect(strFromU8(z[`${D}/secrets/tunnel_key`]!)).toContain(KEY_BODY);
  });

  it("answers 503 with a Japanese message when something is missing", async () => {
    const cases: Partial<Env>[] = [
      { IMGGEN_TUNNEL_KEY: "/k", LOCAL_FILES: files({ "/k": KEY }) },
      { IMGGEN_TOKEN: TOKEN, LOCAL_FILES: files({ "/k": KEY }) },
      { IMGGEN_TOKEN: TOKEN, IMGGEN_TUNNEL_KEY: "/k" },
      { IMGGEN_TOKEN: TOKEN, IMGGEN_TUNNEL_KEY: "/missing", LOCAL_FILES: files({}) },
      { IMGGEN_TOKEN: TOKEN, IMGGEN_TUNNEL_KEY: "/k", LOCAL_FILES: files({ "/k": "not a key" }) },
    ];
    for (const env of cases) {
      const r = await mk(env);
      expect(r.status).toBe(503);
      const b = (await r.json()) as { error: string; code: string };
      expect(b.code).toBe("unconfigured");
      expect(b.error).toMatch(/[ぁ-んァ-ン]/);
      expect(b.error).not.toContain(TOKEN);
    }
  });
});

/** Runs the vendored Python (stdlib only at import time) to check the photo policy end to end. */
describe("imggen-home photo r18 policy (Python)", () => {
  const app = join(__dirname, "../../imggen-home/app");
  const py = (code: string) => JSON.parse(execFileSync("python3", ["-I", "-B", "-c", `import sys, json; sys.path.insert(0, ${JSON.stringify(app)})\n${code}`], { encoding: "utf8" }));
  it("photo r18 preset: adult positives first (gender kept), strong minor negatives, no NSFW-avoidance; all-ages unchanged", () => {
    const r = py(`import generate as g
p = g.PHOTO_PRESETS["photo"]
out = {k: g.build_prompts("photo", "r18", t, p) for k, t in {"girl": "1girl, lying on a bed, nude", "both": "a young man and a woman kissing", "none": "sunset beach"}.items()}
out["all"] = g.build_prompts("photo", "all_ages", "a woman in a park", p)
print(json.dumps(out))`);
    expect(r.girl[0]).toMatch(/^adult woman, mature adult, 25 years old, adult body proportions, a woman, lying on a bed, nude, RAW photo/);
    expect(r.girl[0]).not.toMatch(/\bgirl\b|1girl/);
    expect(r.both[0]).toMatch(/^adult woman and adult man, mature adults, both 25 years old or older, adult body proportions, a man and a woman kissing/);
    expect(r.none[0]).toMatch(/^adult, mature adult, 25 years old, adult body proportions, sunset beach/);
    for (const k of ["girl", "both", "none"]) {
      const neg = r[k][1] as string;
      expect(neg.startsWith("child, loli, shota, toddler, infant, baby, underage, kindergarten, children, kid, teen, teenager, adolescent, minor")).toBe(true);
      for (const w of ["schoolgirl", "school uniform", "young-looking", "baby face", "petite", "flat chest", "aged down"]) expect(neg).toContain(w);
      expect(neg).not.toContain("nsfw");
    }
    expect(r.all[0]).toBe("a woman in a park, RAW photo, photorealistic, natural lighting, sharp focus, high detail, film grain");
    expect(r.all[1]).toMatch(/^nsfw, nude, naked, explicit, sexual, cleavage, underwear, lingerie, child, loli/);
  });
  it("safety: photo r18 refuses youth/school/age and real people, allows adults; all-ages refuses sexual words", () => {
    const r = py(`import safety as s
cases = ["a woman, 25 years old, nude", "1girl, nude", "女子高生", "制服の女性", "若く見える女性", "a woman, 17 years old", "a teen", "schoolgirl", "a celebrity nude", "女優そっくり"]
out = {t: s.check_photo_prompt_safety(t, "r18")[0] for t in cases}
out["all:nude"] = s.check_photo_prompt_safety("a woman, nude", "all_ages")[0]
out["all:celebrity"] = s.check_photo_prompt_safety("a celebrity", "all_ages")[0]
out["all:park"] = s.check_photo_prompt_safety("a woman in a park")[0]
out["loli"] = s.check_prompt_safety("adult woman, loli")[0]
print(json.dumps(out))`);
    expect(r).toEqual({
      "a woman, 25 years old, nude": true, "1girl, nude": true, "女子高生": false, "制服の女性": false, "若く見える女性": false,
      "a woman, 17 years old": false, "a teen": false, "schoolgirl": false, "a celebrity nude": false, "女優そっくり": false,
      "all:nude": false, "all:celebrity": false, "all:park": true, loli: false,
    });
  });
  it("Python and TypeScript youth lists are the same", async () => {
    const { PHOTO_R18_YOUTH_TERMS } = await import("../../worker/modules/images/logic");
    expect(py("import safety as s\nprint(json.dumps(s.PHOTO_R18_YOUTH_TERMS))")).toEqual(PHOTO_R18_YOUTH_TERMS);
  });
});
