import { spawnSync } from "node:child_process";
import { fstatSync, readlinkSync, readSync } from "node:fs";
import { consumeControllerBootstrap } from "../../assets/dsh/action-controller.mjs";

const originalInput = process.platform === "linux" ? readlinkSync("/proc/self/fd/0") : "";
const bootstrap = await consumeControllerBootstrap();
let inputClosed;
try {
  inputClosed =
    process.platform === "win32"
      ? readSync(0, Buffer.alloc(1), 0, 1, null) === 0
      : fstatSync(0).isCharacterDevice();
} catch (error) {
  if (error.code !== "EBADF") throw error;
  inputClosed = true;
}
if (!inputClosed) throw new Error("bootstrap input is still open");
const child = spawnSync(
  process.execPath,
  [
    "--input-type=module",
    "--eval",
    `
      import { readFileSync, readlinkSync, readdirSync } from 'node:fs';
      const linux = process.platform === 'linux';
      const parent = '/proc/' + process.ppid;
      const environment = linux ? readFileSync(parent + '/environ', 'utf8') : '';
      const command = linux ? readFileSync(parent + '/cmdline', 'utf8') : '';
      const originalInput = ${JSON.stringify(originalInput)};
      const descriptors = linux ? readdirSync(parent + '/fd').map((fd) => {
        try { return readlinkSync(parent + '/fd/' + fd); } catch { return ''; }
      }) : [];
      console.log(JSON.stringify({
        linux,
        parentInputClosed: !linux || !descriptors.includes(originalInput),
        environmentClean: !environment.includes('A'.repeat(43)) && !environment.includes('/action/mcp') && !environment.includes('DSH_ACTION_CONTROLLER_MCP='),
        commandClean: !command.includes('A'.repeat(43)) && !command.includes('/action/mcp'),
      }));
    `,
  ],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);
if (child.status !== 0) throw new Error(child.stderr || "bootstrap child probe failed");
process.stdout.write(
  JSON.stringify({
    accepted: bootstrap.tools.length,
    inputClosed,
    child: JSON.parse(child.stdout),
  }),
);
