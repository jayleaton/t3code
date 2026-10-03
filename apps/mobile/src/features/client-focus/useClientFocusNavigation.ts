import { useNavigation } from "@react-navigation/native";
import { useEffect } from "react";

import { setMobileClientFocusHandler } from "../../connection/client-focus";
import { fileRoutePathSegments } from "../files/filePath";

/** Shows threads and files that an agent brings on screen on this device. */
export function useClientFocusNavigation(): void {
  const navigation = useNavigation();
  useEffect(() => {
    setMobileClientFocusHandler(async (environmentId, request) => {
      const target = request.target;
      // Mobile has no Agents board; the request is a no-op here.
      if (target._tag === "agents") return;
      const thread = { environmentId: String(environmentId), threadId: String(target.threadId) };
      navigation.navigate("Thread", thread);
      if (target._tag === "file") {
        navigation.navigate("ThreadFile", {
          ...thread,
          path: fileRoutePathSegments(target.path),
          ...(target.line === undefined ? {} : { line: String(target.line) }),
        });
      }
    });
    return () => setMobileClientFocusHandler(null);
  }, [navigation]);
}
