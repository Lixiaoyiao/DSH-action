import { createHash } from "node:crypto";

// Fixed, synthetic fixture; no remote download or model answer supplies this oracle.
export const SESSION_IMAGE_SHA256 =
  "6b931d2bb32abd286838356b03b235f204bdab5fcc5627af34927b8b4bbe0b90";
export const SESSION_IMAGE_BYTES = 137;

export function sessionImageInstruction(phase, enabled) {
  if (!enabled) return "Do not call tools, read files, modify anything or make external requests.";
  return phase === "save"
    ? "Before answering, call read_image exactly once on /workspace/test/fixtures/images/solid.png. Do not call other tools, modify anything or make external requests."
    : "Use the image already present in this restored Session history. Do not call tools, read any path, download images, modify anything or make external requests.";
}

/** The fixture admits exactly its one known PNG, independent of candidate parsers. */
export function inspectSessionImage(files, manifest, events, enabled) {
  const calls = events.filter((event) => event.type === "tool/call");
  const images = events
    .filter((event) => event.type === "tool/result")
    .flatMap((event) => event.data?.message?.content ?? [])
    .filter((block) => block.type === "image");
  if (!enabled) {
    if (calls.length !== 0 || images.length !== 0 || manifest.attachments !== undefined)
      throw new Error("SESSION_E2E_UNEXPECTED_ATTACHMENT");
    return undefined;
  }
  const file = files["attachment-0.bin"];
  const hash = file === undefined ? undefined : createHash("sha256").update(file).digest("hex");
  const entry = manifest.attachments?.[0];
  const ref = images[0]?.attachment;
  if (
    calls.length !== 1 ||
    calls[0].data?.name !== "read_image" ||
    calls[0].data?.turn !== 1 ||
    images.length !== 1 ||
    manifest.attachments?.length !== 1 ||
    entry.file !== "attachment-0.bin" ||
    entry.bytes !== SESSION_IMAGE_BYTES ||
    entry.sha256 !== SESSION_IMAGE_SHA256 ||
    file?.byteLength !== SESSION_IMAGE_BYTES ||
    hash !== SESSION_IMAGE_SHA256 ||
    ref?.attachmentId !== `sha256:${hash}` ||
    ref?.bytes !== SESSION_IMAGE_BYTES ||
    ref?.mediaType !== "image/png" ||
    ref?.width !== 32 ||
    ref?.height !== 32
  )
    throw new Error("SESSION_E2E_IMAGE_ATTACHMENT");
  return hash;
}

/** Controller tools remain unused; Controlled mode must report its one real read receipt. */
export function sessionImageReceipts(result, expected) {
  const receipts = result?.loop?.dshToolReceipts ?? [];
  if (expected.imageAttachment !== true || expected.phase !== "save") return receipts.length === 0;
  if (expected.dshMode === "native") return receipts.length === 0;
  return (
    receipts.length === 1 &&
    receipts[0].id === "workspace.read" &&
    receipts[0].runtimeName === "read_image" &&
    receipts[0].completed === true &&
    receipts[0].ok === true
  );
}
