import type {
  PeersCommand,
  PeersContext,
  PeersEventPayloads,
  PeersEvents,
  PeersHost,
} from "../index.js";
import { toolRecorder } from "./adapter-tool-fixture.js";

export function extensionFixture(overrides: Partial<PeersHost> = {}) {
  const handlers: Partial<PeersEvents> = {};
  const commands = new Map<string, PeersCommand>();
  const tools = toolRecorder();
  const on = <Name extends keyof PeersEvents>(name: Name, handler: PeersEvents[Name]): void => {
    handlers[name] = handler;
  };
  const api: PeersHost = {
    on,
    registerTool: tools.registerTool,
    registerCommand: (name, options) => {
      commands.set(name, options);
    },
    sendMessage: () => undefined,
    appendEntry: () => undefined,
    registerEntryRenderer: () => undefined,
    ...overrides,
  };
  const event = async <Name extends keyof PeersEvents>(
    name: Name,
    payload: PeersEventPayloads[Name],
    context: PeersContext,
  ): Promise<void> => {
    const handler = handlers[name];
    if (handler === undefined) {
      throw new TypeError(`Unregistered fixture event: ${name}`);
    }
    await handler(payload, context);
  };
  const command = async (name: string, args: string, context: PeersContext): Promise<void> => {
    const options = commands.get(name);
    if (options === undefined) {
      throw new TypeError(`Unregistered fixture command: ${name}`);
    }
    await options.handler(args, context);
  };
  return { api, commands, command, event, tools };
}
