import { useAtomValue } from "@effect/atom-react";
import { useEffect } from "react";

import { networkMembers } from "./networkMembers";
import { useAtomCommand } from "./use-atom-command";

/** Follows the user's network live through every connected member and opens its members here. */
export function NetworkMembersSync() {
  const reports = useAtomValue(networkMembers.reportsAtom);
  const dueOpens = useAtomValue(networkMembers.dueOpensAtom);
  const follow = useAtomCommand(networkMembers.follow, "network members follow");
  const renew = useAtomCommand(networkMembers.renew, { reportFailure: false });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes the followed hosts' rosters into the saved catalog
  useEffect(() => {
    void follow(reports);
  }, [reports, follow]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens members not saved here and re-opens refused ones through another member; the runtime bounds, spaces and limits attempts
  useEffect(() => {
    for (const due of dueOpens) void renew(due);
  }, [dueOpens, renew]);
  return null;
}
