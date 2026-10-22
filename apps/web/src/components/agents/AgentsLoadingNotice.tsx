import { useState } from "react";

export function AgentsLoadingNotice({ ready }: { ready: boolean }) {
  const [initialLoadComplete, setInitialLoadComplete] = useState(ready);
  if (ready && !initialLoadComplete) setInitialLoadComplete(true);

  // An unavailable machine can alternate between backoff and connecting while
  // the board remains usable. Its retries must not reinsert an initial banner.
  return ready || initialLoadComplete ? null : (
    <p role="status" className="agents-notice">
      Loading connected environments…
    </p>
  );
}
