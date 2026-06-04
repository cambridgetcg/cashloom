import { describe, it, expect } from "vitest";
import { publicIdFromUrl } from "./cloudinary-url";

describe("publicIdFromUrl", () => {
  it("extracts folder/name from a versioned upload URL", () => {
    expect(
      publicIdFromUrl(
        "https://res.cloudinary.com/demo/image/upload/v1700000000/images/abc123.jpg"
      )
    ).toBe("images/abc123");
  });

  it("works without a version segment", () => {
    expect(
      publicIdFromUrl("https://res.cloudinary.com/demo/image/upload/images/x.png")
    ).toBe("images/x");
  });

  it("ignores a query string", () => {
    expect(
      publicIdFromUrl(
        "https://res.cloudinary.com/demo/image/upload/v1/images/x.jpg?_a=ab"
      )
    ).toBe("images/x");
  });

  it("returns null for non-Cloudinary / unexpected urls", () => {
    expect(publicIdFromUrl("https://example.com/pic.jpg")).toBeNull();
    expect(publicIdFromUrl("")).toBeNull();
    // @ts-expect-error guarding non-string input
    expect(publicIdFromUrl(null)).toBeNull();
  });
});
