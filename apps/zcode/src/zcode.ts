import { randomUUID, createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { execa as exec } from "execa";
import { Fault, type Outcome } from "@agenvo/protocol";
import type { RuntimeEvent } from "@agenvo/protocol/events";
import { bounded, registered, type Adapter, type Method } from "@agenvo/connector/adapters/adapter";
import { z } from "zod";
import { readApiKey, type ZCodeConfig } from "./config.js";
import { schemas, type MethodName } from "./methods.js";
import {
  ProtocolClient,
  ProtocolError,
  runtimePreferences,
} from "./protocol.js";

type SessionSummary = {
  sessionId: string;
  title?: string;
  phase?: string;
  lastOutcome?: string;
  sessionEnded?: boolean;
};

type Interaction = {
  interactionId: string;
  kind?: string;
  prompt?: string;
  options?: { optionId: string; label?: string; optionKind?: string }[];
};

const WAKE_PHASES = new Set(["idle", "error", "waiting_input"]);

export class ZCodeAdapter implements Adapter {
  available = false;
  version = "unknown";
  onAvailabilityChange?: () => void;

  private stopped = false;
  private generation = randomUUID();
  private client?: ProtocolClient;
  private reconnectTimer?: NodeJS.Timeout;
  private listeners = new Set<(event: RuntimeEvent) => void>();
  private connectionId = randomUUID();
  private clientId = randomUUID();
  private sessions = new Map<string, SessionSummary>();
  private interactions = new Map<string, Interaction[]>();
  private subscribedConversations = new Set<string>();
  private materialized = new Set<string>();
  private sessionModels = new Map<string, { providerId: string; modelId: string }>();
  private readonly configuredModel?: { providerId: string; modelId: string };
  private defaultModel?: { providerId: string; modelId: string };
  private indexReady: Promise<void> = (() => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return Object.assign(promise, { resolve });
  })();

  constructor(readonly config: ZCodeConfig) {
    if (config.defaultModel) {
      const [providerId, modelId] = config.defaultModel.split("/");
      if (providerId && modelId) this.configuredModel = { providerId, modelId };
    }
  }

  /**
   * Plan providers (account:zai-*) authenticate against the plan endpoint with
   * per-turn credentials only the desktop can mint; without them every turn 401s.
   * Route sends through the configured personal default instead.
   */
  private effectiveModel(sessionId: string) {
    const session = this.sessionModels.get(sessionId);
    if (session && !session.providerId.startsWith("account:")) return session;
    return this.configuredModel ?? session;
  }

  methods(): Method[] {
    const methods = (Object.keys(schemas) as MethodName[]).map((name) => ({
      name,
      description: schemas[name].description,
      readOnly: schemas[name].readOnly,
      inputSchema: z.toJSONSchema(schemas[name].schema, {
        io: "input",
        unrepresentable: "any",
      }),
    }));
    return registered(methods);
  }

  watchEvents(emit: (event: RuntimeEvent) => void) {
    this.listeners.add(emit);
    return () => {
      this.listeners.delete(emit);
    };
  }

  private emit(nativeType: string, native: Record<string, unknown>, threadId?: string) {
    const event: RuntimeEvent = {
      eventId: randomUUID(),
      timestamp: new Date().toISOString(),
      serviceId: this.config.id,
      generation: this.generation,
      nativeType,
      native,
      ...(threadId ? { threadId } : {}),
    };
    for (const listener of this.listeners) listener(event);
  }

  private get workspaceId() {
    return this.config.cwd;
  }

  async init() {
    await this.connect();
  }

  private async connect() {
    if (this.stopped) return;
    this.indexReady = (() => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => (resolve = r));
      return Object.assign(promise, { resolve });
    })();
    const binary =
      this.config.binary === "zcode" ? "zcode" : this.config.node;
    const args =
      this.config.binary === "zcode"
        ? ["app-server", "--stdio"]
        : [this.config.binary, "app-server", "--stdio"];
    const client = new ProtocolClient(binary, args, {
      cwd: this.config.cwd,
      handlers: { onRequest: (r) => this.serve(r), onNotification: (n) => this.observe(n) },
    });
    this.client = client;
    client.onExit = () => this.lost();
    try {
      client.start();
      await client.ready();
      const version = await this.detectVersion();
      if (version) this.version = version;
      // Connection-scoped registration: the sessions-index topic for this workspace.
      await client.request("v4/conversation/subscribe", {
        topic: `sessions-index/${this.workspaceId}`,
        connectionId: this.connectionId,
        clientMode: "desktop-continuous",
      });
      await client
        .request("v4/conversation/subscribe", {
          topic: `workspace-config/${this.workspaceId}`,
          connectionId: this.connectionId,
          clientMode: "desktop-continuous",
        })
        .catch(() => {
          /* optional catalog; model defaults stay unresolved */
        });
      if (this.stopped) return;
      // The session list comes from the first index frame; wait so callers
      // never observe an empty catalog on a healthy runtime.
      await Promise.race([
        this.indexReady,
        new Promise((r) => setTimeout(r, 15000)),
      ]);
      this.available = true;
      this.onAvailabilityChange?.();
      this.emit("agenvo.resync_required", { reason: "native_connected", replay: false });
    } catch (error) {
      client.stop();
      if (this.client === client) this.client = undefined;
      throw error;
    }
  }

  private async detectVersion() {
    try {
      if (this.config.binary === "zcode")
        return (await exec("zcode", ["--version"], { timeout: 15000 })).stdout.trim();
      return (
        await exec(this.config.node, [this.config.binary, "--version"], { timeout: 15000 })
      ).stdout.trim();
    } catch {
      return undefined;
    }
  }

  /** Server-to-client requests: preferences, provider auth, host dialogs. */
  private async serve(request: { id: number | string; method: string; params?: any }) {
    switch (request.method) {
      case "session/requestRuntimePreferences":
        return runtimePreferences;
      case "interaction/requestProviderRuntimeHeaders": {
        const apiKey = await readApiKey(this.config);
        if (!apiKey)
          throw new ProtocolError(
            -32001,
            "No coding-plan API key configured (instance api-key-file)",
          );
        return { headersApplied: true, requestAuth: { apiKey } };
      }
      default:
        // Host UI surfaces (dialogs, official MCP auth) are not available headless.
        throw new ProtocolError(-32601, `agenvo-zcode: ${request.method} not handled`);
    }
  }

  /** Notifications: topic frames, state patches. */
  private observe(message: Record<string, any>) {
    if (message.method === "v4/conversation/frame") {
      const topic = String(message.params?.topic ?? "");
      const payload = message.params?.frame?.payload;
      if (!payload) return;
      if (topic.startsWith("sessions-index/")) {
        this.applySessionsIndex(payload);
        (this.indexReady as any).resolve?.();
      } else if (topic.startsWith("workspace-config/")) this.applyWorkspaceConfig(payload);
      else if (topic.startsWith("conversation/")) this.applyConversation(payload, topic);
    }
  }

  /** Track the workspace default model for sends into foreign/resumed sessions. */
  private applyWorkspaceConfig(payload: any) {
    const options = payload?.snapshot?.config?.configOptions ?? payload?.config?.configOptions ?? [];
    const model = options.find((o: any) => o?.id === "model");
    const value = model?.options?.find((o: any) => o?.value === model?.currentValue);
    if (model?.currentValue && value?.modelProviderId)
      this.defaultModel = { providerId: value.modelProviderId, modelId: model.currentValue };
  }

  /**
   * Sessions created by other hosts (the desktop app) live in the shared
   * session store, not in this process. session/resume materializes them here
   * so commands can target them; it is idempotent for live sessions.
   */
  private async ensureMaterialized(sessionId: string) {
    if (this.materialized.has(sessionId) || !this.client) return;
    const resumed: any = await this.client
      .request("session/resume", { sessionId }, 45000)
      .catch(() => undefined);
    this.materialized.add(sessionId);
    const cfg = resumed?.config ?? resumed?.settings;
    if (cfg) {
      const selection =
        cfg.modelSelection ??
        (cfg.provider && cfg.model ? { providerId: cfg.provider, modelId: cfg.model } : undefined);
      if (selection?.providerId && selection?.modelId)
        this.sessionModels.set(sessionId, selection);
    }
    this.ensureConversation(sessionId);
    if (!this.sessionModels.has(sessionId))
      await Promise.race([
        new Promise<void>((resolve) => {
          const timer = setInterval(() => {
            if (this.sessionModels.has(sessionId)) {
              clearInterval(timer);
              resolve();
            }
          }, 250);
          setTimeout(() => {
            clearInterval(timer);
            resolve();
          }, 4000);
        }),
      ]);
  }

  private applySessionsIndex(payload: any) {
    if (payload.kind === "snapshot") {
      for (const session of payload.snapshot?.sessions ?? []) this.trackSession(session);
    } else if (payload.kind === "deltas") {
      for (const delta of payload.deltas ?? []) {
        if (delta.op === "session.upserted" && delta.session) this.trackSession(delta.session);
        if (delta.op === "session.removed" && delta.sessionId)
          this.sessions.delete(delta.sessionId);
      }
    }
  }

  private trackSession(session: any) {
    if (typeof session?.sessionId !== "string") return;
    const before = this.sessions.get(session.sessionId);
    this.sessions.set(session.sessionId, { ...before, ...session });
    const phase = session.phase;
    if (phase && phase !== before?.phase) {
      this.emit(
        "session.phase",
        {
          phase,
          lastOutcome: session.lastOutcome,
          title: session.title,
          sessionId: session.sessionId,
        },
        session.sessionId,
      );
      if (WAKE_PHASES.has(phase)) this.ensureConversation(session.sessionId);
    }
  }

  private applyConversation(payload: any, topic?: string) {
    const sessionIdFromTopic = topic?.startsWith("conversation/")
      ? decodeURIComponent(topic.slice("conversation/".length))
      : undefined;
    if (payload.kind === "snapshot") this.trackConversationSnapshot(payload.snapshot);
    else if (payload.kind === "deltas")
      for (const delta of payload.deltas ?? [])
        this.trackConversationDelta(delta, sessionIdFromTopic);
  }

  private trackConversationSnapshot(snapshot: any) {
    const sessionId = snapshot?.sessionId ?? snapshot?.session?.id;
    const config = snapshot?.config;
    if (typeof sessionId === "string" && config) {
      const selection =
        config.modelSelection ??
        (config.provider && config.model
          ? { providerId: config.provider, modelId: config.model }
          : undefined);
      if (selection?.providerId && selection?.modelId)
        this.sessionModels.set(String(sessionId), selection);
    }
    const pending = snapshot?.pendingInteractions ?? [];
    this.interactions.set(String(sessionId), this.normalizeInteractions(pending));
    this.emitInteractionState(String(sessionId));
  }

  /**
   * Conversations deliver pending interactions as key-level state patches:
   * {op: "state.updated", patch: {pendingInteractions: [...]}}. Every change
   * replaces the whole list — mirror that instead of merging.
   */
  private trackConversationDelta(delta: any, sessionIdFromTopic?: string) {
    if (delta?.op !== "state.updated") return;
    const patch = delta.patch ?? {};
    if (patch.pendingInteractions === undefined) return;
    const sessionId = sessionIdFromTopic;
    if (!sessionId) return;
    this.interactions.set(sessionId, this.normalizeInteractions(patch.pendingInteractions));
    this.emitInteractionState(sessionId);
  }

  private normalizeInteractions(pending: unknown): Interaction[] {
    if (!Array.isArray(pending)) return [];
    return pending
      .map((item: any) => {
        const payload = item?.payload ?? {};
        const prompt =
          typeof payload.summary === "string"
            ? payload.summary
            : typeof payload.question === "string"
              ? payload.question
              : undefined;
        const options = Array.isArray(payload.options)
          ? payload.options.map((option: any) => ({
              optionId: String(option?.optionId ?? ""),
              label: typeof option?.label === "string" ? option.label : undefined,
              optionKind: option?.kind,
            }))
          : undefined;
        return {
          interactionId: String(item?.interactionId ?? ""),
          kind: item?.kind ?? payload?.kind,
          prompt,
          ...(options ? { options } : {}),
        } satisfies Interaction;
      })
      .filter((item) => item.interactionId);
  }

  private emitInteractionState(sessionId: string) {
    const pending = this.interactions.get(sessionId) ?? [];
    if (pending.length)
      this.emit(
        "interaction.pending",
        { count: pending.length, interactions: pending },
        sessionId,
      );
  }

  private async ensureConversation(sessionId: string) {
    if (this.subscribedConversations.has(sessionId) || !this.client) return;
    this.subscribedConversations.add(sessionId);
    try {
      await this.client.request("v4/conversation/subscribe", {
        topic: `conversation/${sessionId}`,
        connectionId: this.connectionId,
        clientMode: "desktop-continuous",
      });
    } catch {
      this.subscribedConversations.delete(sessionId);
    }
  }

  private lost() {
    if (this.stopped) return;
    this.available = false;
    this.generation = randomUUID();
    this.subscribedConversations.clear();
    this.materialized.clear();
    this.client = undefined;
    this.onAvailabilityChange?.();
    this.emit("agenvo.resync_required", { reason: "native_disconnected", replay: false });
    this.reconnectTimer = setTimeout(() => {
      void this.connect().catch(() => {});
    }, 2000);
  }

  private command(type: string, payload: Record<string, unknown>, sessionId: string | null) {
    if (!this.client) throw new Fault("runtime_unavailable");
    return this.client.request(
      "v4/command",
      {
        commandId: randomUUID(),
        clientId: this.clientId,
        sessionId,
        type,
        payload,
        issuedAt: Date.now(),
      },
      45000,
    );
  }

  private ack(outcome: { status?: string; reasonCode?: string; message?: string; result?: any }): Outcome {
    const status = outcome.status ?? "failed";
    const nativeIds = outcome.result?.sessionId
      ? { sessionId: outcome.result.sessionId }
      : undefined;
    if (status === "accepted" || status === "noop" || status === "duplicate")
      return bounded({
        execution: "accepted",
        result: { ack: outcome },
        ...(nativeIds ? { nativeIds } : {}),
      });
    return bounded({
      execution: status === "stale" ? "unknown" : "rejected",
      result: { ack: outcome },
      ...(nativeIds ? { nativeIds } : {}),
    });
  }

  async call(name: string, raw: Record<string, unknown>): Promise<Outcome> {
    if (!Object.hasOwn(schemas, name)) throw new Fault("unknown_method", name);
    const parsed = schemas[name as MethodName].schema.safeParse(raw);
    if (!parsed.success)
      throw new Fault(
        "invalid_params",
        parsed.error.issues
          .map((issue) => `${JSON.stringify(issue.path)}: ${issue.message}`)
          .join("; "),
      );
    if (!this.available || !this.client || this.stopped)
      throw new Fault("runtime_unavailable");
    const p = parsed.data as Record<string, any>;

    switch (name) {
      case "session.delete": {
        await this.ensureMaterialized(p.sessionId);
        const ack = await this.command("deleteSession", {}, p.sessionId);
        if (ack?.status === "accepted") {
          this.sessions.delete(p.sessionId);
          this.interactions.delete(p.sessionId);
          this.sessionModels.delete(p.sessionId);
        }
        return this.ack(ack);
      }
      case "session.rename": {
        await this.ensureMaterialized(p.sessionId);
        const ack = await this.command("renameSession", { title: p.title }, p.sessionId);
        return this.ack(ack);
      }
      case "session.compact": {
        await this.ensureMaterialized(p.sessionId);
        const ack = await this.command("compact", {}, p.sessionId);
        return this.ack(ack);
      }
      case "version.get":
        return bounded({
          execution: "accepted",
          result: { version: this.version, wire: "v4-wire3", workspaceId: this.workspaceId },
        });
      case "session.list":
        return bounded({
          execution: "accepted",
          result: { sessions: [...this.sessions.values()] },
        });
      case "session.create": {
        await this.ensureAccountConfig();
        const ack = await this.command(
          "createSession",
          {
            workspaceId: this.workspaceId,
            firstInput: {
              text: p.text,
              ...(p.model
                ? {
                    modelSelection: {
                      providerId: "account:zai-individual-coding-plan",
                      modelId: p.model,
                    },
                  }
                : {}),
            },
            config: {
              ...(p.mode ? { mode: p.mode } : {}),
              ...(p.planEnabled !== undefined ? { planEnabled: p.planEnabled } : {}),
            },
          },
          null,
        );
        const sessionId = ack?.result?.sessionId;
        if (sessionId) {
          this.materialized.add(sessionId);
          this.ensureConversation(sessionId);
        }
        return this.ack(ack);
      }
      case "session.send": {
        await this.ensureAccountConfig();
        await this.ensureMaterialized(p.sessionId);
        const ack = await this.command(
          "sendText",
          {
            text: p.text,
            ...(p.mode ? { mode: p.mode } : {}),
            ...(this.effectiveModel(p.sessionId)
              ? { modelSelection: this.effectiveModel(p.sessionId)! }
              : {}),
          },
          p.sessionId,
        );
        return this.ack(ack);
      }
      case "session.stop": {
        await this.ensureMaterialized(p.sessionId);
        const ack = await this.command("stop", {}, p.sessionId);
        return this.ack(ack);
      }
      case "session.read": {
        await this.ensureConversation(p.sessionId);
        const result = await this.client.request(
          "v4/conversation/rowsRange",
          {
            sessionId: p.sessionId,
            limit: p.limit,
            ...(p.beforeRowId !== undefined ? { beforeRowId: p.beforeRowId } : {}),
          },
          30000,
        );
        // Tool rows carry full payloads; slim them so pages fit the 64 KiB relay
        // frame. Full payloads stay native — narrower reads or the desktop UI.
        const slim = (result as any)?.rows?.map((row: any) => {
          if (row.kind !== "toolCall" && row.kind !== "toolResult") return row;
          const strip = (value: unknown) =>
            typeof value === "string" && value.length > 400
              ? value.slice(0, 400) + "…"
              : value;
          return {
            ...row,
            inputText: strip(row.inputText),
            outputText: strip(row.outputText),
            result: strip(row.result),
            output: strip(row.output),
          };
        });
        return bounded({
          execution: "accepted",
          result: slim ? { ...result, rows: slim } : result,
          nativeIds: { sessionId: p.sessionId },
        });
      }
      case "interaction.list": {
        await this.ensureConversation(p.sessionId);
        return bounded({
          execution: "accepted",
          result: {
            interactions: this.interactions.get(p.sessionId) ?? [],
          },
          nativeIds: { sessionId: p.sessionId },
        });
      }
      case "interaction.resolve": {
        const ack = await this.command(
          "resolveInteraction",
          {
            interactionId: p.interactionId,
            answer: {
              ...(p.optionId ? { optionId: p.optionId } : {}),
              ...(p.freeText ? { freeText: p.freeText } : {}),
              ...(p.action ? { action: p.action } : {}),
            },
          },
          p.sessionId,
        );
        return this.ack(ack);
      }
      default:
        throw new Fault("unknown_method", name);
    }
  }

  /**
   * Mirrors the CLI's config revision: `zcode-builtin:<release>:<sha256(path)>`
   * where the path is the materialized active builtin config the runtime uses.
   * A wrong value is silently ignored by the registry, so pick the newest
   * materialized release directory, exactly like the runtime's newest-wins rule.
   */
  private builtinRevision(): string {
    try {
      const root = join(homedir(), ".zcode/v2/runtime/provider");
      const candidates: { version: string[]; path: string }[] = [];
      for (const platform of readdirSync(root)) {
        const platformDir = join(root, platform);
        for (const version of readdirSync(platformDir)) {
          const versionDir = join(platformDir, version);
          let endpoints: string[];
          try {
            endpoints = readdirSync(versionDir).filter((d) => d.startsWith("endpoint-"));
          } catch {
            continue;
          }
          for (const endpoint of endpoints) {
            const file = join(versionDir, endpoint, "zcode-builtin.json");
            candidates.push({
              version: version.split(/[.]/).map((n) => Number(n) || 0),
              path: file,
            });
          }
        }
      }
      candidates.sort((a, b) => b.version.join(".").localeCompare(a.version.join("."), undefined, { numeric: true }));
      const file = candidates[0]?.path;
      if (!file) return "33";
      const release = JSON.parse(readFileSync(file, "utf8"))?.revision ?? "33";
      return `zcode-builtin:${release}:${createHash("sha256").update(resolve(file)).digest("hex")}`;
    } catch {
      return "33";
    }
  }

  /**
   * Push the account provider envelope so the registry exposes the coding-plan
   * provider in host-managed mode (the desktop normally does this).
   */
  private accountConfigSynced = false;
  private async ensureAccountConfig() {
    if (this.accountConfigSynced || !this.client) return;
    const providers: Record<string, unknown> = {};
    const states: Record<string, unknown> = {};
    // Start-plan overlays must carry their model whitelist explicitly: an
    // absent list is treated as authoritatively empty, unlike other plans.
    const planModels = ["GLM-5.3", "GLM-5.3-Flash", "GLM-5.2", "GLM-5-Turbo"];
    const overlays: Record<string, unknown> = {
      "account:zai-individual-coding-plan": {
        access: { type: "zhipu-account", entitled: true },
      },
      "account:zai-start-plan": {
        access: { type: "zhipu-account", entitled: true },
        builtinModelIds: planModels,
      },
    };
    for (const [providerId, overlay] of Object.entries(overlays)) {
      providers[providerId] = overlay;
      states[providerId] = { availability: "available", entitled: true, current: true };
    }
    try {
      await this.client.request(
        "provider/updateAccountConfig",
        {
          revision: "agenvo-" + Date.now(),
          basedOnZCodeBuiltinRevision: this.builtinRevision(),
          providers,
          states,
        },
        15000,
      );
      await this.client.request("provider/refreshRegistry", { reason: "agenvo-connector" }, 15000);
      this.accountConfigSynced = true;
    } catch {
      /* registry stays on personal providers; model calls may still work */
    }
  }

  async close() {
    this.stopped = true;
    this.available = false;
    clearTimeout(this.reconnectTimer);
    this.client?.stop();
    this.client = undefined;
    this.listeners.clear();
  }
}
