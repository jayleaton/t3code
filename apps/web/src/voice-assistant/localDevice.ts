/** A remote page origin is not evidence that its server runs on the client device. */
export function isLocalVoiceHost(input: {
  desktop: boolean;
  localEnabled: boolean;
  hostname: string;
}): boolean {
  if (input.desktop) return input.localEnabled;
  return (
    input.hostname === "localhost" || input.hostname === "127.0.0.1" || input.hostname === "[::1]"
  );
}

export function isLoopbackVoiceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      isLocalVoiceHost({ desktop: false, localEnabled: true, hostname: url.hostname })
    );
  } catch {
    return false;
  }
}

/** Only direct loopback connections prove the executor is on the browser's device. */
export function selectVoiceDevice<T extends string>(
  candidates: ReadonlyArray<{
    id: T;
    url: string | null;
    direct: boolean;
    connected: boolean;
    supported: boolean;
  }>,
): T | null {
  const local = candidates.filter(
    (candidate) =>
      candidate.direct &&
      candidate.connected &&
      candidate.supported &&
      candidate.url !== null &&
      isLoopbackVoiceUrl(candidate.url),
  );
  return local.length === 1 ? local[0]!.id : null;
}
