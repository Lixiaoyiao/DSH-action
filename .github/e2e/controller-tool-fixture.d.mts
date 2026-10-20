export function controllerToolName(id: string): string;

export function controllerToolReply(
  body: {
    readonly messages?: readonly unknown[];
    readonly tools?: readonly unknown[];
  },
  route: string,
  index: number,
  plan: readonly { readonly id: string; readonly input: Readonly<Record<string, unknown>> }[],
):
  | {
      readonly role: "assistant";
      readonly tool_calls: readonly {
        readonly index: number;
        readonly id: string;
        readonly type: "function";
        readonly function: { readonly name: string; readonly arguments: string };
      }[];
    }
  | undefined;
