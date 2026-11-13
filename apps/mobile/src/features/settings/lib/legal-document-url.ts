import { LICENSE_URL } from "@t3tools/shared/cliRelease";

function webDocumentIdentity(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;

    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    return `${url.origin}${pathname}`;
  } catch {
    return null;
  }
}

const LICENSE_IDENTITY = webDocumentIdentity(LICENSE_URL);

export function isLegalDocumentUrl(value: string): boolean {
  const identity = webDocumentIdentity(value);
  return identity !== null && identity === LICENSE_IDENTITY;
}
