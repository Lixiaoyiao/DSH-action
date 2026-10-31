import { describe, it, expect } from "vitest";
import { RunDiagnostics } from "../src/dsh/diagnostics.js";
import { executeBoundedDshProcess } from "../src/dsh/process.js";

describe("live Worker diagnostics", () => {
  it("retains the last tool and step on timeout without exposing tool input or model text", async () => {
    const trace = new RunDiagnostics("basic", () => undefined, ["private-key"]);
    const script = `process.stdout.write(JSON.stringify({type:'status',phase:'step_start',turn:1,step:2})+'\\n');process.stdout.write(JSON.stringify({type:'tool_call',callId:'call-1',tool:'web_fetch',input:{secret:'private-key'}})+'\\n');process.stdout.write(JSON.stringify({type:'thinking',text:'private thinking'})+'\\n');setInterval(()=>{},1000)`;
    await expect(
      executeBoundedDshProcess(
        { command: process.execPath, args: ["-e", script], cwd: process.cwd(), env: {} },
        {
          timeoutMs: 1000,
          maxStdoutBytes: 65536,
          maxStderrBytes: 65536,
          maxCombinedBytes: 131072,
          onStdout: (chunk) => trace.stdout(chunk),
        },
      ),
    ).rejects.toMatchObject({ code: "DSH_TIMEOUT" });
    const result = JSON.stringify(trace.snapshot());
    expect(result).toContain("web_fetch");
    expect(result).toContain("step_start");
    expect(result).not.toContain("private-key");
    expect(result).not.toContain("private thinking");
  });
  it("decodes split UTF-8 and JSON lines and ignores malformed telemetry", () => {
    const trace = new RunDiagnostics("basic", () => undefined);
    const bytes = Buffer.from(
      '{"type":"text","text":"你好"}\n{"type":"final","text":"secret result"}\n',
    );
    for (const byte of bytes) trace.stdout(Buffer.from([byte]));
    expect(trace.snapshot().events.some((e) => e.phase === "final")).toBe(true);
    expect(JSON.stringify(trace.snapshot())).not.toContain("secret result");
  });
});
