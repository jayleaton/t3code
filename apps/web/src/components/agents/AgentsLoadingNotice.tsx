import { useEffect, useState } from "react";

export function AgentsLoadingNotice({ ready }: { ready: boolean }) {
  const [initialLoadComplete, setInitialLoadComplete] = useState(ready);
  useEffect(() => {
    if (ready) setInitialLoadComplete(true);
  }, [ready]);

  // An unavailable machine can alternate between backoff and connecting while
  // the board remains usable. Its retries must not reinsert an initial banner.
  return ready || initialLoadComplete ? null : (
    <p role="status" className="agents-notice">
      Loading connected environments…
    </p>
  );
}
