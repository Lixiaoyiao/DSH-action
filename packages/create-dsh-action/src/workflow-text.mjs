/** Generated workflows use LF; Git may check the same text out with CRLF. */
export function canonicalWorkflowText(contents) {
  return contents.replaceAll("\r\n", "\n");
}
