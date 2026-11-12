import { randomBytes as nodeRandomBytes } from "node:crypto";
export const randomBytes = (n: number): Uint8Array => new Uint8Array(nodeRandomBytes(n));
export const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
