import { useLocation, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";

// Settings, Usage, and Pull Requests replace the sidebar utility row with a
// Back button. Everything else is the main app. Legacy `/projects/<key>` links
// redirect into settings, so they count too and are never remembered.
export function isSidebarUtilityPage(pathname: string) {
  return (
    pathname === "/settings" ||
    pathname.startsWith("/settings/") ||
    pathname.startsWith("/projects/") ||
    pathname === "/usage" ||
    pathname === "/pull-requests"
  );
}

export function isAgentsPage(pathname: string) {
  return pathname === "/agents" || pathname.startsWith("/agents/");
}

/** The two ways to work: the Agents board, or the thread list and its chats. */
export type WorkspaceView = "agents" | "threads";

// Kept per window, so a reload on a utility page still returns to the view
// (and the chat) it was opened from.
const STORAGE_KEY = "t3code:main-app-location";

interface MainAppLocation {
  /** The latest main app URL, which a utility page's Back returns to. */
  href: string | null;
  view: WorkspaceView;
  /** The latest URL in each view, which switching views returns to. */
  hrefByView: Record<WorkspaceView, string | null>;
}

function readStoredLocation(): MainAppLocation {
  const empty: MainAppLocation = {
    href: null,
    view: "threads",
    hrefByView: { agents: null, threads: null },
  };
  try {
    const stored = window.sessionStorage.getItem(STORAGE_KEY);
    return stored ? { ...empty, ...(JSON.parse(stored) as Partial<MainAppLocation>) } : empty;
  } catch {
    return empty;
  }
}

let location: MainAppLocation | null = null;
const current = () => (location ??= readStoredLocation());

function store(next: MainAppLocation) {
  location = next;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage can be unavailable; the in-memory location still works.
  }
}

/**
 * Records that a chat opened on the thread route is shown in the threads view.
 * The route alone cannot tell: an agent chat opened there from the Agents view
 * moves to the Agents board instead.
 */
export function enterThreadsView(href: string) {
  store({ ...current(), view: "threads", hrefByView: { ...current().hrefByView, threads: href } });
}

export function readWorkspaceView(): WorkspaceView {
  return current().view;
}

// Mount once in the app shell. Records the latest main app URL so Back can
// return there no matter how many utility pages were visited since.
export function MainAppLocationTracker() {
  const href = useLocation({
    select: (location) => (isSidebarUtilityPage(location.pathname) ? null : location.href),
  });
  const pathname = useLocation({ select: (location) => location.pathname });
  useEffect(() => {
    if (href === null) return;
    const previous = current();
    // Thread routes report their view through enterThreadsView once the chat is known.
    const view: WorkspaceView | null = isAgentsPage(pathname)
      ? "agents"
      : /^\/[^/]+\/[^/]+$/.test(pathname) && !pathname.startsWith("/draft/")
        ? null
        : "threads";
    store({
      href,
      view: view ?? previous.view,
      hrefByView: view ? { ...previous.hrefByView, [view]: href } : previous.hrefByView,
    });
  }, [href, pathname]);
  return null;
}

/** The main app URL a utility page returns to: the last one visited, else the thread list. */
export function readMainAppHref(): string {
  return current().href ?? "/";
}

// Leaves a utility page for the last main app URL, or the thread list when
// the app was opened directly on a utility page.
export function useNavigateToMainApp() {
  const navigate = useNavigate();
  return useCallback(() => navigate({ href: readMainAppHref() }), [navigate]);
}

/** Switches between the Agents board and the threads view, back to where each was left. */
export function useToggleWorkspaceView() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  return useCallback(
    (target?: WorkspaceView) => {
      const onAgents =
        isAgentsPage(pathname) ||
        (isSidebarUtilityPage(pathname) && readWorkspaceView() === "agents");
      const view = target ?? (onAgents ? "threads" : "agents");
      // Set first: a thread route reads the view to decide where an agent chat belongs.
      store({ ...current(), view });
      return navigate({
        href: current().hrefByView[view] ?? (view === "agents" ? "/agents" : "/"),
      });
    },
    [navigate, pathname],
  );
}
