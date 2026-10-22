export function resolveRepositoryRoot(cwd?: string): Promise<string>;

export interface ProcessOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string;
  readonly timeoutMs?: number;
}

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly failure?: "timeout" | "output_limit" | "tool_unavailable";
  readonly termination?: "requested" | "unconfirmed";
}

export function runProcess(
  command: string,
  args: readonly string[],
  options?: ProcessOptions,
): Promise<ProcessResult>;
