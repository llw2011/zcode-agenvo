import { realpath, access, constants } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { execa as exec } from "execa";
import { Fault } from "@agenvo/protocol";
import { validatePaths } from "@agenvo/connector/config";
import type { Backend } from "@agenvo/connector/backend";
import { instanceConfigSchema, executionPolicy, type ZCodeConfig } from "./config.js";
import { ZCodeAdapter } from "./zcode.js";

const readable = (path: string) =>
  access(path, constants.R_OK).then(
    () => true,
    () => false,
  );

/** Locate the zcode CLI: env override, desktop bundle, PATH shim. */
async function resolveBinary(override: unknown): Promise<string> {
  const candidates = [
    typeof override === "string" && override ? override : undefined,
    process.env.ZCODE_BIN,
    join(homedir(), "AppData/Local/Programs/ZCode/resources/glm/zcode.cjs"),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    const path = await realpath(candidate).catch(() => undefined);
    if (path && (await readable(path))) return path;
  }
  // PATH shim (zcode.cmd / zcode) — keep the resolved absolute path.
  const shim = await exec("zcode", ["--version"], { timeout: 15000 }).then(
    () => true,
    () => false,
  );
  if (shim) return "zcode";
  throw new Fault(
    "binary_not_found",
    "No zcode CLI found; pass --binary PATH (zcode.cjs) or set ZCODE_BIN",
  );
}

export const backend: Backend<ZCodeConfig> = {
  name: "zcode",
  command: "agenvo-zcode",
  schema: instanceConfigSchema,
  options: ["binary", "cwd", "api-key-file", "default-model"],
  help: "[--binary PATH] [--cwd PATH] [--api-key-file PATH]",
  executionPolicy,
  revision: () => "zcode-appserver-v4-wire3-v1",
  async configure(options) {
    const binary = await resolveBinary(options.binary);
    return instanceConfigSchema.parse({
      id: options.id,
      label: options.label ?? options.id,
      kind: "zcode",
      node: process.execPath,
      binary,
      cwd: await realpath(String(options.cwd ?? process.cwd())),
      ...(options["api-key-file"]
        ? { apiKeyFile: await realpath(String(options["api-key-file"])) }
        : {}),
      ...(options["default-model"]
        ? { defaultModel: String(options["default-model"]) }
        : {}),
    });
  },
  async create(config) {
    const adapter = new ZCodeAdapter(config);
    try {
      await validatePaths([config.node, config.binary, config.cwd]);
      await adapter.init();
    } catch {
      adapter.available = false;
      await adapter.close();
    }
    return adapter;
  },
  async doctor(config) {
    const binary = config.binary === "zcode" ? "zcode" : config.node;
    const args = config.binary === "zcode" ? ["--version"] : [config.binary, "--version"];
    try {
      const { stdout } = await exec(binary, args, { timeout: 15000 });
      return [{ check: config.id + ":version", ok: true, detail: stdout.trim() }];
    } catch (error: any) {
      return [
        {
          check: config.id + ":version",
          ok: false,
          detail: String(error?.stderr ?? error?.message ?? error).slice(0, 200),
        },
      ];
    }
  },
};
