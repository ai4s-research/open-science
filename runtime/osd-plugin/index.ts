// Open Science Desktop's OpenCode plugin: what the app adds to every session.
//
// - The host tools: present_artifact, ssh_connect, computer.
// - The host UI contract (how to display an artifact) on every model request.
// - The browser lease: one browser per conversation, launched as Settings say.
// - The conversation a shell command runs for, as OSD_ORIGIN_SESSION, so `osd`
//   called from inside a conversation says where it comes from. The gateway
//   records it in the audit log and limits how fast one conversation may
//   message others, so two agents cannot talk to each other without end.
//
// OpenCode supplies `@opencode/plugin` to the plugins it loads; nothing here is
// installed from npm.
import { Plugin } from "@opencode/plugin";
import { ARTIFACT_PRESENTATION_SYSTEM, presentArtifact, presentArtifactTool, type PresentInput } from "./artifact";
import { applyBrowserLease } from "./browser";
import { ShellOrigins } from "./origin";
import { computerTool, runComputer } from "./computer";
import { sshConnect, sshConnectTool } from "./ssh";

type ToolContext = {
  sessionID: string;
  agent: string;
  messageID: string;
  id: string;
  signal?: AbortSignal;
};

export default Plugin.define({
  id: "open-science-desktop",
  async setup(ctx: any) {
    // The folder a session works in: tools run for many sessions, and the
    // plugin's own location is only where it was loaded.
    const workspaceOf = async (sessionID: string): Promise<string> => {
      const session = await ctx.session.get({ sessionID });
      const directory = session?.location?.directory;
      if (typeof directory !== "string" || !directory) throw new Error("this session has no workspace folder");
      return directory;
    };

    await ctx.tool.transform((editor: any) => {
      // Called directly, never through Code Mode: the app recognizes these
      // calls by name to act on them (show the artifact, open the sign-in).
      editor.add({
        ...presentArtifactTool,
        options: { codemode: false },
        execute: async (input: PresentInput, context: ToolContext) => ({
          content: await presentArtifact(await workspaceOf(context.sessionID), input),
        }),
      });
      editor.add({
        ...sshConnectTool,
        options: { codemode: false },
        execute: async (input: { host: string }, context: ToolContext) => ({
          content: await sshConnect(input, context.signal),
        }),
      });
      editor.add({
        ...computerTool,
        options: { codemode: false },
        execute: async (input: Record<string, unknown>, context: ToolContext) => {
          // Reading the screen is reading the user's mail and messages, so the
          // whole tool is gated: the rules decide (approve mode asks once,
          // "always" saves it), and a deny blocks it.
          await ctx.permission.assert({
            sessionID: context.sessionID,
            agent: context.agent,
            source: { type: "tool", messageID: context.messageID, id: context.id },
            action: "computer",
            resources: [String(input.app ?? input.action ?? "*")],
            save: ["*"],
          });
          const { output, screenshotPath } = await runComputer(input);
          return screenshotPath
            ? { content: [{ type: "text", text: output }, { type: "file", uri: `file://${screenshotPath}`, mime: "image/png" }] }
            : { content: output };
        },
      });
    });

    await ctx.session.hook("context", (event: any) => {
      event.system.push({ type: "text", text: ARTIFACT_PRESENTATION_SYSTEM });
    });

    // A shell command's session is known to the tool call, not to the shell it
    // creates (OpenCode sets OPENCODE_SESSION_ID only after this hook runs).
    // The tool call is the step just before, so it leaves the command and its
    // session here and the shell picks them up by command text. Two sessions
    // starting the identical command in the same instant could swap; that
    // costs a mislabelled audit line, never a command.
    const shellOrigins = new ShellOrigins();

    await ctx.tool.hook("execute.before", (event: any) => {
      applyBrowserLease(event.tool, event.input, event.sessionID);
      if (event.tool === "shell") shellOrigins.expect(event.input?.command, event.sessionID);
    });

    // `osd` reads OSD_ORIGIN_SESSION. A terminal the user opens has none.
    await ctx.shell.hook("create.before", (event: any) => {
      const session = shellOrigins.take(event.command);
      if (session && event.env) event.env.OSD_ORIGIN_SESSION = session;
    });
  },
});
