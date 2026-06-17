import { describe, it, expect } from "vitest";
import { encryptKey, decryptKey } from "./key-vault";

describe("key vault", () => {
  it("round-trips a private key through encrypt then decrypt", () => {
    const secret = Buffer.from(
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "hex"
    );
    const blob = encryptKey("correct horse battery staple", secret);
    const back = decryptKey("correct horse battery staple", blob);
    expect(back.equals(secret)).toBe(true);
  });

  it("refuses the wrong passphrase", () => {
    const blob = encryptKey("right", Buffer.from("deadbeef", "hex"));
    expect(() => decryptKey("wrong", blob)).toThrow(/Could not decrypt key/);
  });

  it("stores no plaintext in the serialized blob", () => {
    const secret = Buffer.from("supersecret-private-key-material", "utf8");
    const blob = encryptKey("pw", secret);
    expect(JSON.stringify(blob)).not.toContain("supersecret-private-key-material");
  });

  it("uses a fresh salt + iv per encryption (same passphrase, different blobs)", () => {
    const a = encryptKey("pw", Buffer.from([1, 2, 3]));
    const b = encryptKey("pw", Buffer.from([1, 2, 3]));
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
  });
});