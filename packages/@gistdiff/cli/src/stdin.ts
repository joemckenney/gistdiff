/**
 * Read all of stdin as a UTF-8 string. Returns an empty string if stdin
 * is a TTY (i.e. nothing was piped).
 */
export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
