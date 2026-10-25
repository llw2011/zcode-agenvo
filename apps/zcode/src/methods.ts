import { z } from "zod";

const sessionId = z.string().min(1).max(128);
const mode = z.enum(["build", "edit", "plan", "yolo", "guarded"]).optional();

export const schemas = {
  "session.delete": {
    schema: z.strictObject({ sessionId }),
    readOnly: false,
    description:
      "Delete a native session and its persisted history. Use for cleanup after confirming the work is done or no longer needed; deletion is permanent and does not stop a running turn — stop first.",
  },
  "session.rename": {
    schema: z.strictObject({
      sessionId,
      title: z.string().min(1).max(200),
    }),
    readOnly: false,
    description:
      "Rename a native session title. Does not interrupt execution or change history.",
  },
  "session.compact": {
    schema: z.strictObject({ sessionId }),
    readOnly: false,
    description:
      "Compact a long conversation to reclaim context space (native compact command). The CLI summarizes prior turns; original rows stay queryable in native history until pruned.",
  },
  "version.get": {
    schema: z.strictObject({}),
    readOnly: true,
    description:
      "Read the ZCode CLI version and app-server wire revision. Does not establish model availability; provider credentials may still be missing.",
  },
  "session.list": {
    schema: z.strictObject({}),
    readOnly: true,
    description:
      "List native sessions in the configured workspace with live phase (draft/running/idle/waiting_input/error) and lastOutcome. Phase idle does not establish task success; read session output for that.",
  },
  "session.create": {
    schema: z.strictObject({
      text: z.string().min(1).max(65536),
      mode,
      model: z.string().min(1).max(128).optional(),
      planEnabled: z.boolean().optional(),
    }),
    readOnly: false,
    description:
      "Create a native session and submit the first input in one command (delivery startNow). Uses the account coding-plan provider; model defaults to GLM-5.3 (set model to override, e.g. GLM-5.3-Flash). ACK accepted only proves the turn was dispatched, not completed; subscribe to runtime events or poll session.list/session.read for the outcome. mode defaults to the workspace default; prefer build or edit over yolo for remote automation.",
  },
  "session.send": {
    schema: z.strictObject({
      sessionId,
      text: z.string().min(1).max(65536),
      mode,
    }),
    readOnly: false,
    description:
      "Submit a follow-up input to an existing native session. While a turn is running the CLI admission may queue or guide the input; accepted does not mean inference finished or the task succeeded.",
  },
  "session.stop": {
    schema: z.strictObject({ sessionId }),
    readOnly: false,
    description:
      "Interrupt the current turn of a native session. Never retried automatically; a session without a running turn is rejected natively.",
  },
  "session.read": {
    schema: z.strictObject({
      sessionId,
      limit: z.number().int().min(1).max(200).default(50),
      beforeRowId: z.number().int().optional(),
    }),
    readOnly: true,
    description:
      "Read native conversation rows (user inputs, assistant text, tool calls, markers) newest-first with rowId cursors. Bounded reads only; use beforeRowId to page older rows. Output presence does not establish task success.",
  },
  "interaction.list": {
    schema: z.strictObject({ sessionId }),
    readOnly: true,
    description:
      "List pending native interactions (permission requests, user questions) of a session, with option ids for structured answers.",
  },
  "interaction.resolve": {
    schema: z.strictObject({
      sessionId,
      interactionId: z.string().min(1).max(128),
      optionId: z.string().min(1).max(256).optional(),
      freeText: z.string().min(1).max(16384).optional(),
      action: z.enum(["accept", "decline", "cancel"]).optional(),
    }),
    readOnly: false,
    description:
      "Answer a pending native interaction by interactionId using optionId, freeText or an action. Unanswered interactions keep the session blocked; they are never auto-answered by the connector.",
  },
} as const;

export type MethodName = keyof typeof schemas;
