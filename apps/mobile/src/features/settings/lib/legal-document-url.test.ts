import { describe, expect, it } from "vite-plus/test";

import { LICENSE_URL } from "@t3tools/shared/cliRelease";

import { isLegalDocumentUrl } from "./legal-document-url";

describe("isLegalDocumentUrl", () => {
  it.each(["https://example.com/legal", "javascript:alert(1)"])(
    "rejects a URL outside the legal-document allowlist: %s",
    (url) => {
      expect(isLegalDocumentUrl(url)).toBe(false);
    },
  );

  it("allows the fork's license", () => {
    expect(isLegalDocumentUrl(`${LICENSE_URL}/`)).toBe(true);
  });
});
