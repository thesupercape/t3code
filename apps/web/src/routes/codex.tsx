import { createFileRoute } from "@tanstack/react-router";

import { CodexChatsView } from "../components/CodexChatsView";

export const Route = createFileRoute("/codex")({
  validateSearch: (search: Record<string, unknown>) => ({
    thread:
      typeof search.thread === "string" && search.thread.trim().length > 0
        ? search.thread.trim().slice(0, 512)
        : undefined,
  }),
  component: CodexChatsView,
});
