import { createHash, randomBytes } from "node:crypto";

export function sha256(buf: Buffer | string): string {
  return "sha256:" + createHash("sha256").update(buf).digest("hex");
}

export function shortId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}
