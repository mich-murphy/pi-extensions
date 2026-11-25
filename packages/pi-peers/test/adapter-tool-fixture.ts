import type { PeerTool, ToolArguments, ToolHost } from "../adapter/tools.js";

type CapturedTool = Pick<PeerTool, "name" | "execute"> & {
  renderCall: boolean;
  renderResult: boolean;
};

export function toolRecorder() {
  const tools: CapturedTool[] = [];
  const registerTool: ToolHost["registerTool"] = (tool) => {
    tools.push({
      name: tool.name,
      execute: tool.execute.bind(tool),
      renderCall: tool.renderCall !== undefined,
      renderResult: tool.renderResult !== undefined,
    });
  };
  return {
    registerTool,
    tools,
    run: async (name: string, args: ToolArguments, signal?: AbortSignal) => {
      const tool = tools.find((entry) => entry.name === name);
      if (tool === undefined) {
        throw new Error(`Unregistered fixture tool: ${name}`);
      }
      return tool.execute("fixture", args, signal);
    },
  };
}
