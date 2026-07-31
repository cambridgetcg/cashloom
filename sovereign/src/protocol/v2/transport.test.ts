import { describe, expect, it } from "bun:test";
import * as ed25519 from "@noble/ed25519";
import {
  base64UrlEncode,
  canonicalJsonBytes,
  keyIdForPublicKey,
  sha256Id,
  signatureToBase64Url,
  type RecordSigner,
} from "@agenttool/wallet";
import {
  FAIL_CLOSED_ASSET_TRUST_POLICY,
  assetTrustPolicyHash,
} from "./asset-trust.ts";
import {
  createNodeDescriptor,
  createPaymentIntent,
  createPaymentRequest,
  createSelfCertifyingAuthority,
  signV2Record,
  v2Nonce,
  v2RecordBytes,
  type NodeDescriptorCore,
  type SelfCertifyingAuthority,
  type VerifiedV2Record,
} from "./records.ts";
import {
  DirectTransportError,
  V2_RECORD_MEDIA_TYPE,
  getPublicV2Record,
  postV2Record,
  resolveDescriptorRelativeUrl,
  type DirectNodeTarget,
  type FetchLike,
} from "./transport.ts";

interface TestAuthority {
  authority: SelfCertifyingAuthority;
  signer: RecordSigner;
}

const testAuthority = async (seedByte: number): Promise<TestAuthority> => {
  const privateKey = new Uint8Array(32).fill(seedByte);
  const publicKey = base64UrlEncode(await ed25519.getPublicKeyAsync(privateKey));
  expect(keyIdForPublicKey(publicKey)).toBe(
    createSelfCertifyingAuthority(publicKey).key_id,
  );
  return {
    authority: createSelfCertifyingAuthority(publicKey),
    signer: {
      public_key: publicKey,
      async sign_digest(digest) {
        return signatureToBase64Url(
          await ed25519.signAsync(digest, privateKey),
        );
      },
    },
  };
};

const merchant = await testAuthority(31);
const transportNow = () => "2030-01-01T00:03:00.000Z";
const nonce = (byte: number): string =>
  v2Nonce(new Uint8Array(16).fill(byte));
const trustBinding = (label: string) => ({
  manifest_record_id: sha256Id({ manifest: label }),
  manifest_authority_key_id: merchant.authority.key_id,
  policy: FAIL_CLOSED_ASSET_TRUST_POLICY,
  policy_hash: assetTrustPolicyHash(FAIL_CLOSED_ASSET_TRUST_POLICY),
});

const descriptor = await signV2Record(
  createNodeDescriptor({
    authority: merchant.authority,
    audience: "public",
    disclosure: "public",
    nonce: nonce(1),
    issued_at: "2030-01-01T00:00:00.000Z",
    expires_at: "2030-01-08T00:00:00.000Z",
    parent_record_id: null,
    roles: ["merchant"],
    endpoints: [
      { rel: "record_read", path: "/v2/records/{record_id}" },
      { rel: "records_ingest", path: "/v2/records" },
    ],
  }),
  merchant.signer,
);

const publicRecord = await signV2Record(
  createPaymentRequest({
    authority: merchant.authority,
    audience: "public",
    disclosure: "public",
    nonce: nonce(2),
    issued_at: "2030-01-01T00:01:00.000Z",
    expires_at: "2030-01-01T01:00:00.000Z",
    parent_record_id: descriptor.record_id,
    rail: "evm-base",
    destination: "eip155:8453:0x2222222222222222222222222222222222222222",
    asset_id: "eip155:8453/slip44:60",
    amount_atomic: "1000000000000000",
    purpose_hash: sha256Id({ order: "transport-test" }),
    asset_trust: trustBinding("public-record"),
  }),
  merchant.signer,
);

const privateRecord = await signV2Record(
  createPaymentIntent({
    authority: merchant.authority,
    audience: merchant.authority.key_id,
    disclosure: "private",
    nonce: nonce(3),
    issued_at: "2030-01-01T00:02:00.000Z",
    expires_at: "2030-01-01T00:10:00.000Z",
    parent_record_id: publicRecord.record_id,
    rail: publicRecord.rail,
    destination: publicRecord.destination,
    source_account:
      "eip155:8453:0x1111111111111111111111111111111111111111",
    asset_id: "eip155:8453/slip44:60",
    amount_atomic: "1000000000000000",
    fee_asset_id: "eip155:8453/slip44:60",
    fee_limit_scope: "total_fee_asset_exposure",
    max_fee_atomic: "100000000000000",
    payment_asset_trust: trustBinding("private-payment"),
    fee_asset_trust: trustBinding("private-fee"),
  }),
  merchant.signer,
);

const target = (
  descriptorUrl = "https://merchant.example/.well-known/cashloom/v2",
): DirectNodeTarget => ({
  descriptorUrl,
  descriptor,
  expectedNodeKeyId: descriptor.authority.key_id,
  expectedOrigin: new URL(descriptorUrl).origin,
});

const recordResponse = (
  record: VerifiedV2Record,
  init: ResponseInit = {},
): Response =>
  new Response(Uint8Array.from(v2RecordBytes(record)).buffer, {
    status: 200,
    headers: { "content-type": V2_RECORD_MEDIA_TYPE },
    ...init,
  });

const acknowledgementResponse = (
  recordId: string,
  inserted = true,
  status = inserted ? 201 : 200,
): Response =>
  new Response(
    Uint8Array.from(
      canonicalJsonBytes({ inserted, record_id: recordId }),
    ).buffer,
    {
      status,
      headers: { "content-type": "application/json" },
    },
  );

const errorCode = async (
  operation: Promise<unknown>,
): Promise<string | undefined> => {
  try {
    await operation;
    return undefined;
  } catch (error) {
    return error instanceof DirectTransportError ? error.code : undefined;
  }
};

describe("direct-node endpoint boundary", () => {
  it("allows HTTPS and only the explicit HTTP loopback hosts", () => {
    expect(
      resolveDescriptorRelativeUrl(
        "https://node.example/.well-known/cashloom/v2",
        "/v2/records",
      ).href,
    ).toBe("https://node.example/v2/records");

    for (const base of [
      "http://localhost:8787/descriptor",
      "http://127.0.0.1:8787/descriptor",
      "http://[::1]:8787/descriptor",
    ]) {
      expect(resolveDescriptorRelativeUrl(base, "/v2/records").protocol).toBe(
        "http:",
      );
    }

    for (const base of [
      "http://node.example/descriptor",
      "http://127.0.0.2/descriptor",
      "ftp://localhost/descriptor",
    ]) {
      expect(() =>
        resolveDescriptorRelativeUrl(base, "/v2/records"),
      ).toThrow(/must use HTTPS/);
    }
  });

  it("refuses cross-origin, scheme-relative, traversal, and ambiguous paths", () => {
    for (const path of [
      "//evil.example/v2/records",
      "https://evil.example/v2/records",
      "/v2/../admin",
      "/v2/%2e%2e/admin",
      "/v2/records?next=https://evil.example",
      String.raw`/v2\records`,
    ]) {
      expect(() =>
        resolveDescriptorRelativeUrl(
          "https://node.example/.well-known/cashloom/v2",
          path,
        ),
      ).toThrow(DirectTransportError);
    }
  });
});

describe("POST v2 record", () => {
  it("sends the exact canonical bytes once with the record media type and no redirect", async () => {
    const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
      [];
    const fetch: FetchLike = async (input, init) => {
      calls.push({ input, init });
      return acknowledgementResponse(publicRecord.record_id);
    };

    const result = await postV2Record(target(), publicRecord, {
      fetch,
      now: transportNow,
    });
    expect(result).toEqual({
      status: 201,
      record_id: publicRecord.record_id,
      inserted: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toBe("https://merchant.example/v2/records");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.redirect).toBe("error");
    expect(calls[0]!.init?.credentials).toBe("omit");
    expect(
      new Headers(calls[0]!.init?.headers).get("content-type"),
    ).toBe(V2_RECORD_MEDIA_TYPE);
    expect(new Headers(calls[0]!.init?.headers).get("accept")).toBe(
      "application/json",
    );
    expect(
      Array.from(calls[0]!.init?.body as Uint8Array),
    ).toEqual(Array.from(v2RecordBytes(publicRecord)));
  });

  it("never retries HTTP failures and refuses redirect responses", async () => {
    let failures = 0;
    const failedFetch: FetchLike = async () => {
      failures += 1;
      return new Response("unavailable", { status: 503 });
    };
    expect(
      await errorCode(postV2Record(target(), publicRecord, {
        fetch: failedFetch,
        now: transportNow,
      })),
    ).toBe("HTTP_ERROR");
    expect(failures).toBe(1);

    let redirects = 0;
    const redirectFetch: FetchLike = async () => {
      redirects += 1;
      return new Response(null, {
        status: 302,
        headers: { location: "https://elsewhere.example/v2/records" },
      });
    };
    expect(
      await errorCode(postV2Record(target(), publicRecord, {
        fetch: redirectFetch,
        now: transportNow,
      })),
    ).toBe("REDIRECT_REFUSED");
    expect(redirects).toBe(1);
  });

  it("requires a canonical acknowledgement bound to the submitted record", async () => {
    expect(
      await errorCode(
        postV2Record(target(), publicRecord, {
          now: transportNow,
          fetch: async () =>
            acknowledgementResponse(`sha256:${"0".repeat(64)}`),
        }),
      ),
    ).toBe("ACK_MISMATCH");
    expect(
      await errorCode(
        postV2Record(target(), publicRecord, {
          now: transportNow,
          fetch: async () => new Response(null, { status: 204 }),
        }),
      ),
    ).toBe("CONTENT_TYPE");
    expect(
      await errorCode(
        postV2Record(target(), publicRecord, {
          now: transportNow,
          fetch: async () =>
            acknowledgementResponse(publicRecord.record_id, false, 201),
        }),
      ),
    ).toBe("ACK_MISMATCH");
    expect(
      await errorCode(
        postV2Record(target(), publicRecord, {
          now: transportNow,
          fetch: async () =>
            acknowledgementResponse(publicRecord.record_id, true, 202),
        }),
      ),
    ).toBe("ACK_MISMATCH");
  });

  it("enforces a request bound before any network call", async () => {
    let calls = 0;
    const fetch: FetchLike = async () => {
      calls += 1;
      return new Response(null, { status: 204 });
    };
    expect(
      await errorCode(postV2Record(target(), publicRecord, {
        fetch,
        now: transportNow,
        maxRequestBytes: 1,
      })),
    ).toBe("REQUEST_TOO_LARGE");
    expect(calls).toBe(0);
  });

  it("refuses an expired descriptor before any network call", async () => {
    let calls = 0;
    expect(
      await errorCode(
        postV2Record(target(), publicRecord, {
          now: () => "2030-01-08T00:00:00.000Z",
          fetch: async () => {
            calls += 1;
            return new Response(null, { status: 204 });
          },
        }),
      ),
    ).toBe("INVALID_TARGET");
    expect(calls).toBe(0);
  });

  it("refuses a valid descriptor whose key does not match the caller's pin", async () => {
    let calls = 0;
    expect(
      await errorCode(
        postV2Record(
          {
            ...target(),
            expectedNodeKeyId: `sha256:${"0".repeat(64)}`,
          },
          publicRecord,
          {
            now: transportNow,
            fetch: async () => {
              calls += 1;
              return new Response(null, { status: 204 });
            },
          },
        ),
      ),
    ).toBe("INVALID_TARGET");
    expect(calls).toBe(0);
  });

  it("refuses a copied descriptor at an origin other than the caller's pin", async () => {
    let calls = 0;
    expect(
      await errorCode(
        postV2Record(
          {
            ...target("https://attacker.example/.well-known/cashloom/v2"),
            expectedOrigin: "https://merchant.example",
          },
          publicRecord,
          {
            now: transportNow,
            fetch: async () => {
              calls += 1;
              return new Response(null, { status: 204 });
            },
          },
        ),
      ),
    ).toBe("INVALID_TARGET");
    expect(calls).toBe(0);
  });

  it("refuses private bytes when their signed audience is not the target pin", async () => {
    const other = await testAuthority(32);
    const otherDescriptor = await signV2Record(
      createNodeDescriptor({
        authority: other.authority,
        audience: "public",
        disclosure: "public",
        nonce: nonce(9),
        issued_at: "2030-01-01T00:00:00.000Z",
        expires_at: "2030-01-08T00:00:00.000Z",
        parent_record_id: null,
        roles: ["payer"],
        endpoints: [
          { rel: "record_read", path: "/v2/records/{record_id}" },
          { rel: "records_ingest", path: "/v2/records" },
        ],
      }),
      other.signer,
    );
    let calls = 0;
    expect(
      await errorCode(
        postV2Record(
          {
            descriptorUrl: "https://other.example/.well-known/cashloom/v2",
            descriptor: otherDescriptor,
            expectedNodeKeyId: other.authority.key_id,
            expectedOrigin: "https://other.example",
          },
          privateRecord,
          {
            now: transportNow,
            fetch: async () => {
              calls += 1;
              return new Response(null, { status: 204 });
            },
          },
        ),
      ),
    ).toBe("PRIVATE_TARGET_MISMATCH");
    expect(calls).toBe(0);
  });
});

describe("GET public v2 record", () => {
  it("uses the descriptor template, verifies canonical bytes, id, and public disclosure", async () => {
    const requested: string[] = [];
    const fetch: FetchLike = async (input, init) => {
      requested.push(String(input));
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      return recordResponse(publicRecord);
    };

    const received = await getPublicV2Record(
      target(),
      publicRecord.record_id,
      { fetch, now: transportNow },
    );
    expect(received.record_id).toBe(publicRecord.record_id);
    expect(requested).toEqual([
      `https://merchant.example/v2/records/${publicRecord.record_id}`,
    ]);
  });

  it("rejects malformed ids before fetch and valid responses with the wrong id", async () => {
    let calls = 0;
    const fetch: FetchLike = async () => {
      calls += 1;
      return recordResponse(publicRecord);
    };
    await expect(
      getPublicV2Record(target(), "sha256:not-an-id", {
        fetch,
        now: transportNow,
      }),
    ).rejects.toThrow(/64 lowercase hex/);
    expect(calls).toBe(0);

    expect(
      await errorCode(
        getPublicV2Record(target(), `sha256:${"0".repeat(64)}`, {
          fetch,
          now: transportNow,
        }),
      ),
    ).toBe("RECORD_MISMATCH");
    expect(calls).toBe(1);
  });

  it("refuses private records, noncanonical JSON, wrong media, and oversized bodies", async () => {
    expect(
      await errorCode(
        getPublicV2Record(target(), privateRecord.record_id, {
          fetch: async () => recordResponse(privateRecord),
          now: transportNow,
        }),
      ),
    ).toBe("NON_PUBLIC_RECORD");

    const noncanonical = ` ${new TextDecoder().decode(v2RecordBytes(publicRecord))}`;
    await expect(
      getPublicV2Record(target(), publicRecord.record_id, {
        now: transportNow,
        fetch: async () =>
          new Response(noncanonical, {
            status: 200,
            headers: { "content-type": V2_RECORD_MEDIA_TYPE },
          }),
      }),
    ).rejects.toThrow(/not canonical JSON/);

    expect(
      await errorCode(
        getPublicV2Record(target(), publicRecord.record_id, {
          now: transportNow,
          fetch: async () =>
            new Response(Uint8Array.from(v2RecordBytes(publicRecord)).buffer, {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
        }),
      ),
    ).toBe("CONTENT_TYPE");

    expect(
      await errorCode(
        getPublicV2Record(target(), publicRecord.record_id, {
          now: transportNow,
          maxResponseBytes: 64,
          fetch: async () =>
            new Response("small", {
              status: 200,
              headers: {
                "content-type": V2_RECORD_MEDIA_TYPE,
                "content-length": "65",
              },
            }),
        }),
      ),
    ).toBe("RESPONSE_TOO_LARGE");
  });

  it("aborts at the explicit deadline without retrying", async () => {
    let calls = 0;
    const fetch: FetchLike = async (_input, init) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true },
        );
      });
    };

    expect(
      await errorCode(
        getPublicV2Record(target(), publicRecord.record_id, {
          fetch,
          now: transportNow,
          timeoutMs: 5,
        }),
      ),
    ).toBe("TIMEOUT");
    expect(calls).toBe(1);
  });
});
