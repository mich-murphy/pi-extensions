import type { ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { Schema } from "effect";
import { onOffCommand } from "../shared/on-off-command.ts";
import type { OnOffCommand } from "../shared/on-off-command.ts";

const FEEDBACK_TOGGLE_TYPE = "pi-feedback-toggle";

const FeedbackToggle = Schema.Struct({
  version: Schema.Literal(1),
  enabled: Schema.Boolean,
  sessionId: Schema.String,
});

export type FeedbackToggle = typeof FeedbackToggle.Type;

export type FeedbackExposure = "direct" | "hidden";

const isToggle = Schema.is(FeedbackToggle);

export type ToggleSessionContext = {
  readonly sessionManager: Pick<ExtensionContext["sessionManager"], "getEntries" | "getSessionId">;
};

export type FeedbackCommandContext = {
  readonly ui: Pick<ExtensionContext["ui"], "notify">;
  readonly sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId">;
};

export type ToggleRegistration = {
  readonly on: (
    name: "session_start",
    handler: (event: SessionStartEvent, ctx: ToggleSessionContext) => void,
  ) => void;
  readonly registerCommand: (name: string, options: OnOffCommand<FeedbackCommandContext>) => void;
  readonly appendEntry: (customType: string, data: FeedbackToggle) => void;
  readonly getActiveTools: () => Array<string>;
  readonly setActiveTools: (names: Array<string>) => void;
};

function savedSettingForThisSessionId(ctx: ToggleSessionContext): boolean | undefined {
  const sessionId = ctx.sessionManager.getSessionId();

  const saved = ctx.sessionManager
    .getEntries()
    .findLast(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === FEEDBACK_TOGGLE_TYPE &&
        isToggle(entry.data) &&
        entry.data.sessionId === sessionId,
    );

  return saved?.type === "custom" && isToggle(saved.data) ? saved.data.enabled : undefined;
}

function notSaved(enabled: boolean, reason: string): string {
  return `Harness feedback is ${enabled ? "on" : "off"} for now, but the setting could not be saved: ${reason}. Reopening or reloading this session restores the last saved setting.`;
}

export function registerFeedbackToggle(
  pi: ToggleRegistration,
  options: {
    readonly tool: string;
    readonly expose: (exposure: FeedbackExposure) => void;
    readonly note: () => string;
  },
) {
  let recording = true;
  let hidden = false;
  let unsaved: string | undefined;
  const enabled = (): boolean => recording;

  const hide = (next: boolean): void => {
    if (next !== hidden) {
      hidden = next;
      options.expose(next ? "hidden" : "direct");
    }
  };

  pi.on("session_start", (_event, ctx) => {
    recording = savedSettingForThisSessionId(ctx) ?? true;
    hide(!recording);
  });

  const command = onOffCommand<FeedbackCommandContext>({
    name: "feedback",
    label: "Harness feedback",
    description: "Turn harness feedback recording on or off for this session",
    enabled,
    apply: (next, ctx) => {
      recording = next;
      hide(!next);

      const active = pi.getActiveTools();
      if (next && !active.includes(options.tool)) {
        pi.setActiveTools([...active, options.tool]);
      }

      try {
        pi.appendEntry(FEEDBACK_TOGGLE_TYPE, {
          version: 1,
          enabled: next,
          sessionId: ctx.sessionManager.getSessionId(),
        });
      } catch (error) {
        unsaved = error instanceof Error ? error.message : String(error);
      }
    },
    note: options.note,
  });

  pi.registerCommand("feedback", {
    ...command,
    handler: async (args, ctx) => {
      unsaved = undefined;
      await command.handler(args, {
        sessionManager: ctx.sessionManager,
        ui: {
          notify: (message, level) => {
            if (unsaved === undefined) {
              ctx.ui.notify(message, level);
            } else {
              ctx.ui.notify(notSaved(enabled(), unsaved), "warning");
            }
          },
        },
      });
    },
  });

  return { enabled };
}
