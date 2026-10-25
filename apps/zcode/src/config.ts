import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { Fault } from "@agenvo/protocol";
import { absolutePath, commonInstanceFields } from "@agenvo/connector/config";

export const executionPolicy = {
  execution: "native-session-config",
  approvalPolicy: "host-answered-provider-auth",
};
export const instanceConfigSchema = z.strictObject({
  ...commonInstanceFields,
  kind: z.literal("zcode"),
  node: absolutePath,
  binary: absolutePath,
  cwd: absolutePath,
  apiKeyFile: absolutePath.optional(),
  defaultModel: z
    .string()
    .regex(/^[A-Za-z0-9:_\-.]+\/[A-Za-z0-9:_\-.]+$/, "Use providerId/modelId")
    .optional(),
});
export type ZCodeConfig = z.infer<typeof instanceConfigSchema>;

/** Reads the coding-plan API key used to answer provider runtime headers. */
export async function readApiKey(config: ZCodeConfig): Promise<string | undefined> {
  if (!config.apiKeyFile) return undefined;
  const info = await stat(config.apiKeyFile).catch(() => undefined);
  if (!info?.isFile()) return undefined;
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0)
    throw new Fault(
      "insecure_credentials",
      "ZCode API key file must have mode 0600",
    );
  const key = (await readFile(config.apiKeyFile, "utf8")).trim();
  return key || undefined;
}
