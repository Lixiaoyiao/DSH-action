export const SESSION_IMAGE_WORKSPACE: Readonly<{ branch: string; sha: string }>;
export function verifySessionImageWorkspace(
  current: { readonly repository: string; readonly imageAttachment?: boolean },
  reader: { json(path: string): unknown },
): typeof SESSION_IMAGE_WORKSPACE | undefined;
