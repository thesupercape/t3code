import type {
  CodexDesktopMessage,
  CodexDesktopSendStatus,
  CodexDesktopStatusResponse,
  CodexDesktopThread,
} from "@t3tools/contracts";
import {
  AlertCircleIcon,
  ArrowLeftIcon,
  BotIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleDashedIcon,
  LoaderCircleIcon,
  SearchIcon,
  SendIcon,
  WrenchIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";

import { createCodexDesktopApi, type CodexDesktopApi } from "../codexDesktopApi";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { SidebarInset } from "./ui/sidebar";
import { Textarea } from "./ui/textarea";
import { cn, randomUUID } from "~/lib/utils";
import ChatMarkdown from "./ChatMarkdown";
import {
  mergeLatestCodexMessages,
  mergeOlderCodexMessages,
  resolveCodexSelectedThreadId,
  shouldApplyCodexResult,
  shouldPollCodexThread,
} from "./CodexChatsView.logic";

const POLL_INTERVAL_MS = 3_000;
const REQUEST_POLL_INTERVAL_MS = 1_000;
const POST_SEND_OBSERVATION_INTERVAL_MS = 3_000;
const POST_SEND_OBSERVATION_ATTEMPTS = 100;
const defaultCodexDesktopApi = createCodexDesktopApi();

function formatThreadTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (elapsedMinutes < 1) return "now";
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`;
  const hours = Math.floor(elapsedMinutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function statusLabel(status: CodexDesktopStatusResponse["status"]): string {
  if (status === "ready") return "Codex ready";
  if (status === "starting") return "Codex starting";
  return "Codex unavailable";
}

function statusVariant(
  status: CodexDesktopStatusResponse["status"],
): "success" | "warning" | "error" {
  if (status === "ready") return "success";
  if (status === "starting") return "warning";
  return "error";
}

function sendStatusLabel(status: CodexDesktopSendStatus): string {
  if (status === "queued") return "Queued";
  if (status === "sent") return "Sent";
  if (status === "unknown") return "Delivery unconfirmed";
  return "Delivery failed";
}

function MessageBubble({ message }: { message: CodexDesktopMessage }) {
  const isUser = message.role === "user";
  const isTool = message.role === "tool";
  return (
    <article className={cn("flex gap-3", isUser && "justify-end")} data-message-role={message.role}>
      {!isUser ? (
        <div className="mt-1 flex size-7 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/30 text-muted-foreground">
          {isTool ? <WrenchIcon className="size-3.5" /> : <BotIcon className="size-3.5" />}
        </div>
      ) : null}
      <div
        className={cn(
          "max-w-[min(46rem,88%)] rounded-2xl border px-3.5 py-2.5 text-sm leading-relaxed",
          isUser
            ? "border-primary/20 bg-primary text-primary-foreground"
            : "border-border/65 bg-card/45 text-foreground",
        )}
      >
        {isTool && message.tool ? (
          <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <span>{message.tool.name}</span>
            <span aria-hidden>·</span>
            <span>{message.tool.status}</span>
          </div>
        ) : null}
        {isUser ? (
          <p className="whitespace-pre-wrap break-words">{message.text}</p>
        ) : (
          <ChatMarkdown cwd={undefined} text={message.text} className="text-inherit" />
        )}
        {isTool && message.tool?.detail ? (
          <p className="mt-1.5 whitespace-pre-wrap break-words text-xs text-muted-foreground">
            {message.tool.detail}
          </p>
        ) : null}
      </div>
    </article>
  );
}

function ThreadRow({
  thread,
  selected,
  onSelect,
}: {
  thread: CodexDesktopThread;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "group flex w-full items-start gap-2.5 rounded-xl px-3 py-2.5 text-left transition-colors",
        selected
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/55 hover:text-foreground",
      )}
    >
      <BotIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground/70" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {thread.title?.trim() || "Untitled Codex chat"}
          </span>
          <span className="shrink-0 text-[10px] text-muted-foreground/60">
            {formatThreadTime(thread.updatedAt)}
          </span>
        </span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground/75">
          {thread.preview?.trim() || "No messages yet"}
        </span>
      </span>
      <ChevronRightIcon className="mt-1 size-3.5 shrink-0 text-muted-foreground/50 opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}

export function CodexChatsView({ api = defaultCodexDesktopApi }: { api?: CodexDesktopApi }) {
  const routeSearch = useSearch({ from: "/codex" });
  const navigate = useNavigate({ from: "/codex" });
  const [hostStatus, setHostStatus] = useState<CodexDesktopStatusResponse | null>(null);
  const [threads, setThreads] = useState<readonly CodexDesktopThread[]>([]);
  const [threadDetails, setThreadDetails] = useState<ReadonlyMap<string, CodexDesktopThread>>(
    new Map(),
  );
  const [threadListCursor, setThreadListCursor] = useState<string | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(
    routeSearch.thread ?? null,
  );
  const [messages, setMessages] = useState<readonly CodexDesktopMessage[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [listState, setListState] = useState<"loading" | "ready" | "error">("loading");
  const [historyState, setHistoryState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [composer, setComposer] = useState("");
  const [sendState, setSendState] = useState<{
    status: CodexDesktopSendStatus;
    error?: string;
  } | null>(null);
  const [pendingRequest, setPendingRequest] = useState<{
    threadId: string;
    requestId: string;
    text: string;
  } | null>(null);
  const [observationTimedOut, setObservationTimedOut] = useState(false);
  const [mobileListOpen, setMobileListOpen] = useState(routeSearch.thread == null);
  const requestPollRef = useRef<number | null>(null);
  const sendObservationRef = useRef<number | null>(null);
  const initialRouteThreadIdRef = useRef(routeSearch.thread);
  const autoSelectedRouteThreadIdRef = useRef<string | null>(null);
  const historyRequestRef = useRef(0);
  const listRequestRef = useRef(0);
  const selectedThreadIdRef = useRef<string | null>(null);
  const sendGenerationRef = useRef(0);
  const historyScrollRef = useRef<HTMLDivElement>(null);
  selectedThreadIdRef.current = selectedThreadId;

  const selectedThread = useMemo(() => {
    if (!selectedThreadId) return null;
    return (
      threadDetails.get(selectedThreadId) ??
      threads.find((thread) => thread.id === selectedThreadId) ??
      null
    );
  }, [selectedThreadId, threadDetails, threads]);

  const loadThreads = useCallback(async () => {
    const requestNumber = ++listRequestRef.current;
    setListState((state) => (state === "ready" ? state : "loading"));
    try {
      const trimmedSearch = search.trim();
      const response = await api.listThreads(
        trimmedSearch.length > 0 ? { search: trimmedSearch } : {},
      );
      if (requestNumber !== listRequestRef.current) return;
      setThreads(response.threads);
      setThreadListCursor(response.nextCursor);
      const nextSelectedId = resolveCodexSelectedThreadId({
        currentId: selectedThreadIdRef.current,
        requestedId: initialRouteThreadIdRef.current,
        threads: response.threads,
      });
      setSelectedThreadId(nextSelectedId);
      const selectedId = nextSelectedId;
      if (!initialRouteThreadIdRef.current && selectedId !== undefined) {
        autoSelectedRouteThreadIdRef.current = selectedId;
        void navigate({ search: { thread: selectedId ?? undefined }, replace: true });
      }
      setListState("ready");
      setError(null);
    } catch (cause) {
      if (requestNumber !== listRequestRef.current) return;
      setListState("error");
      setError(cause instanceof Error ? cause.message : "Could not load Codex chats.");
    }
  }, [api, navigate, search]);

  const loadMoreThreads = useCallback(async () => {
    if (threadListCursor === null) return;
    const requestNumber = ++listRequestRef.current;
    try {
      const response = await api.listThreads({
        cursor: threadListCursor,
        ...(search.trim().length > 0 ? { search: search.trim() } : {}),
      });
      if (requestNumber !== listRequestRef.current) return;
      setThreads((current) => {
        const seen = new Set(current.map((thread) => thread.id));
        return [...current, ...response.threads.filter((thread) => !seen.has(thread.id))];
      });
      setThreadListCursor(response.nextCursor);
    } catch (cause) {
      if (requestNumber !== listRequestRef.current) return;
      setError(cause instanceof Error ? cause.message : "Could not load more Codex chats.");
    }
  }, [api, search, threadListCursor]);

  useEffect(() => {
    if (routeSearch.thread !== selectedThreadId) setSelectedThreadId(routeSearch.thread ?? null);
  }, [routeSearch.thread, selectedThreadId]);

  useEffect(() => {
    if (autoSelectedRouteThreadIdRef.current === routeSearch.thread) {
      autoSelectedRouteThreadIdRef.current = null;
      return;
    }
    setMobileListOpen(routeSearch.thread == null);
  }, [routeSearch.thread]);

  useEffect(() => {
    let cancelled = false;
    void api
      .getStatus()
      .then((status) => {
        if (!cancelled) setHostStatus(status);
      })
      .catch((cause) => {
        if (!cancelled) {
          setHostStatus({
            status: "unavailable",
            hostId: null,
            error: cause instanceof Error ? cause.message : "Could not reach Codex.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void loadThreads(), search ? 180 : 0);
    return () => window.clearTimeout(timeout);
  }, [loadThreads, search]);

  const loadHistory = useCallback(
    async (preserveOlder = true) => {
      const requestNumber = ++historyRequestRef.current;
      if (!selectedThreadId) {
        setMessages([]);
        setHistoryCursor(null);
        setHistoryState("idle");
        return null;
      }
      setHistoryState((state) => (state === "ready" ? state : "loading"));
      try {
        const response = await api.getThread(selectedThreadId);
        if (requestNumber !== historyRequestRef.current) return null;
        setThreadDetails((current) => new Map(current).set(response.thread.id, response.thread));
        setMessages((current) =>
          preserveOlder ? mergeLatestCodexMessages(current, response.messages) : response.messages,
        );
        setHistoryCursor(response.nextCursor);
        setHistoryState("ready");
        setError(null);
        return response;
      } catch (cause) {
        if (requestNumber !== historyRequestRef.current) return null;
        setHistoryState("error");
        setError(cause instanceof Error ? cause.message : "Could not load this Codex chat.");
        return null;
      }
    },
    [api, selectedThreadId],
  );

  const loadOlderHistory = useCallback(async () => {
    if (!selectedThreadId || historyCursor === null) return;
    const requestNumber = ++historyRequestRef.current;
    const scrollElement = historyScrollRef.current;
    const previousScrollHeight = scrollElement?.scrollHeight ?? 0;
    try {
      const response = await api.getThread(selectedThreadId, { beforeCursor: historyCursor });
      if (requestNumber !== historyRequestRef.current) return;
      setThreadDetails((current) => new Map(current).set(response.thread.id, response.thread));
      setMessages((current) => {
        return mergeOlderCodexMessages(current, response.messages);
      });
      setHistoryCursor(response.nextCursor);
      if (scrollElement) {
        window.requestAnimationFrame(() => {
          scrollElement.scrollTop += scrollElement.scrollHeight - previousScrollHeight;
        });
      }
    } catch (cause) {
      if (requestNumber !== historyRequestRef.current) return;
      setError(cause instanceof Error ? cause.message : "Could not load older messages.");
    }
  }, [api, historyCursor, selectedThreadId]);

  useEffect(() => {
    void loadHistory(false);
  }, [loadHistory]);

  useEffect(() => {
    if (!selectedThread || !shouldPollCodexThread(selectedThread.status)) return;
    const interval = window.setInterval(() => void loadHistory(), POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [loadHistory, selectedThread]);

  useEffect(() => {
    return () => {
      if (requestPollRef.current !== null) window.clearInterval(requestPollRef.current);
      if (sendObservationRef.current !== null) window.clearTimeout(sendObservationRef.current);
    };
  }, []);

  const handleSelectThread = (threadId: string) => {
    if (requestPollRef.current !== null) {
      window.clearInterval(requestPollRef.current);
      requestPollRef.current = null;
    }
    if (sendObservationRef.current !== null) {
      window.clearTimeout(sendObservationRef.current);
      sendObservationRef.current = null;
    }
    setSelectedThreadId(threadId);
    void navigate({ search: { thread: threadId } });
    setMobileListOpen(false);
    setSendState(null);
    setPendingRequest(null);
    setComposer("");
    setMessages([]);
    setHistoryCursor(null);
    setHistoryState("loading");
    setObservationTimedOut(false);
    sendGenerationRef.current += 1;
  };

  const observeAfterSend = useCallback(
    (threadId: string, generation: number) => {
      let attempts = 0;
      const refresh = async () => {
        if (
          !shouldApplyCodexResult({
            currentThreadId: selectedThreadIdRef.current,
            resultThreadId: threadId,
            currentGeneration: sendGenerationRef.current,
            resultGeneration: generation,
          })
        )
          return;
        const response = await loadHistory();
        if (!response) {
          sendObservationRef.current = null;
          return;
        }
        if (
          !shouldApplyCodexResult({
            currentThreadId: selectedThreadIdRef.current,
            resultThreadId: threadId,
            currentGeneration: sendGenerationRef.current,
            resultGeneration: generation,
          })
        )
          return;
        attempts += 1;
        if (
          response.thread.status === "error" ||
          response.thread.status === "needs_attention" ||
          attempts >= POST_SEND_OBSERVATION_ATTEMPTS
        ) {
          sendObservationRef.current = null;
          if (attempts >= POST_SEND_OBSERVATION_ATTEMPTS) setObservationTimedOut(true);
          return;
        }
        sendObservationRef.current = window.setTimeout(
          () => void refresh(),
          POST_SEND_OBSERVATION_INTERVAL_MS,
        );
      };
      void refresh();
    },
    [loadHistory],
  );

  const handleSend = async () => {
    const text = composer.trim();
    if (!selectedThreadId || text.length === 0 || sendState?.status === "queued") return;
    const threadId = selectedThreadId;
    const generation = sendGenerationRef.current;
    const requestId =
      pendingRequest?.threadId === threadId && pendingRequest.text === text
        ? pendingRequest.requestId
        : randomUUID();
    setPendingRequest({ threadId, requestId, text });
    setSendState({ status: "queued" });
    setObservationTimedOut(false);
    try {
      const response = await api.sendMessage(threadId, { requestId, text });
      if (
        !shouldApplyCodexResult({
          currentThreadId: selectedThreadIdRef.current,
          resultThreadId: threadId,
          currentGeneration: sendGenerationRef.current,
          resultGeneration: generation,
        })
      )
        return;
      setSendState({
        status: response.status,
        ...(response.error ? { error: response.error } : {}),
      });
      if (response.status === "sent") {
        setComposer("");
        setPendingRequest(null);
        observeAfterSend(threadId, generation);
      }
      if (response.status === "queued") {
        if (requestPollRef.current !== null) window.clearInterval(requestPollRef.current);
        requestPollRef.current = window.setInterval(() => {
          void api
            .getRequest(requestId)
            .then((next) => {
              if (
                !shouldApplyCodexResult({
                  currentThreadId: selectedThreadIdRef.current,
                  resultThreadId: threadId,
                  currentGeneration: sendGenerationRef.current,
                  resultGeneration: generation,
                })
              )
                return;
              setSendState({ status: next.status, ...(next.error ? { error: next.error } : {}) });
              if (next.status !== "queued") {
                if (requestPollRef.current !== null) window.clearInterval(requestPollRef.current);
                requestPollRef.current = null;
                if (next.status === "sent") {
                  setComposer("");
                  setPendingRequest(null);
                  observeAfterSend(threadId, generation);
                }
              }
            })
            .catch((cause) => {
              if (
                !shouldApplyCodexResult({
                  currentThreadId: selectedThreadIdRef.current,
                  resultThreadId: threadId,
                  currentGeneration: sendGenerationRef.current,
                  resultGeneration: generation,
                })
              )
                return;
              setSendState({
                status: "unknown",
                error: cause instanceof Error ? cause.message : "Delivery status unavailable.",
              });
            });
        }, REQUEST_POLL_INTERVAL_MS);
      }
    } catch (cause) {
      if (
        !shouldApplyCodexResult({
          currentThreadId: selectedThreadIdRef.current,
          resultThreadId: threadId,
          currentGeneration: sendGenerationRef.current,
          resultGeneration: generation,
        })
      )
        return;
      setSendState({
        status: "error",
        error: cause instanceof Error ? cause.message : "Could not send message.",
      });
    }
  };

  const currentSendError = sendState?.error ?? error;
  const showList = mobileListOpen;
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-border/65 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/25 text-muted-foreground">
              <BotIcon className="size-4" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold">Codex chats</h1>
              <p className="truncate text-xs text-muted-foreground/70">Native Codex sessions</p>
            </div>
          </div>
          {hostStatus ? (
            <Badge variant={statusVariant(hostStatus.status)} size="sm">
              {hostStatus.status === "ready" ? <CheckCircle2Icon /> : <CircleDashedIcon />}
              {statusLabel(hostStatus.status)}
            </Badge>
          ) : null}
        </header>

        <div className="flex min-h-0 flex-1">
          <aside
            className={cn(
              "flex w-full shrink-0 flex-col border-r border-border/65 bg-muted/[0.08] sm:w-72 lg:w-80",
              !showList && "hidden sm:flex",
            )}
          >
            <div className="border-b border-border/50 p-3">
              <div className="flex h-9 items-center gap-2 rounded-lg border border-border/65 bg-background/55 px-2.5">
                <SearchIcon className="size-3.5 shrink-0 text-muted-foreground/75" />
                <Input
                  nativeInput
                  unstyled
                  value={search}
                  onChange={(event) => setSearch(event.currentTarget.value)}
                  placeholder="Search Codex chats"
                  aria-label="Search Codex chats"
                  className="min-w-0 flex-1 [&_[data-slot=input]]:h-auto [&_[data-slot=input]]:p-0 [&_[data-slot=input]]:text-sm [&_[data-slot=input]]:placeholder:text-muted-foreground/60"
                />
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {listState === "loading" ? (
                <div className="flex items-center justify-center gap-2 px-3 py-8 text-xs text-muted-foreground">
                  <LoaderCircleIcon className="size-3.5 animate-spin" /> Loading Codex chats
                </div>
              ) : listState === "error" ? (
                <div className="px-3 py-8 text-center text-xs text-muted-foreground">
                  <AlertCircleIcon className="mx-auto mb-2 size-4 text-destructive" />
                  {error ?? "Could not load Codex chats."}
                  <Button
                    className="mx-auto mt-3"
                    size="xs"
                    variant="outline"
                    onClick={() => void loadThreads()}
                  >
                    Retry
                  </Button>
                </div>
              ) : threads.length === 0 ? (
                <p className="px-3 py-8 text-center text-xs text-muted-foreground">
                  No Codex chats found.
                </p>
              ) : (
                <div className="flex flex-col gap-0.5">
                  {threads.map((thread) => (
                    <ThreadRow
                      key={thread.id}
                      thread={thread}
                      selected={thread.id === selectedThreadId}
                      onSelect={() => handleSelectThread(thread.id)}
                    />
                  ))}
                  {threadListCursor ? (
                    <Button
                      className="mt-2 w-full"
                      size="xs"
                      variant="ghost-muted"
                      onClick={() => void loadMoreThreads()}
                    >
                      Load more
                    </Button>
                  ) : null}
                </div>
              )}
            </div>
          </aside>

          <section className={cn("flex min-w-0 flex-1 flex-col", showList && "hidden sm:flex")}>
            <div className="flex min-h-14 shrink-0 items-center gap-2 border-b border-border/65 px-4 py-3 sm:px-6">
              <Button
                size="icon-sm"
                variant="ghost-muted"
                className="sm:hidden"
                aria-label="Back to Codex chats"
                onClick={() => setMobileListOpen(true)}
              >
                <ArrowLeftIcon />
              </Button>
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-sm font-medium">
                  {selectedThread?.title?.trim() ||
                    (selectedThread ? "Untitled Codex chat" : "Select a Codex chat")}
                </h2>
                {selectedThread?.cwd ? (
                  <p className="truncate text-xs text-muted-foreground/65">{selectedThread.cwd}</p>
                ) : null}
              </div>
              {selectedThread ? (
                <Badge variant="outline" size="sm">
                  {selectedThread.status}
                </Badge>
              ) : null}
            </div>

            <div
              ref={historyScrollRef}
              className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-8"
            >
              {!selectedThread ? (
                <div className="flex h-full items-center justify-center text-center">
                  <div className="max-w-sm">
                    <BotIcon className="mx-auto mb-3 size-7 text-muted-foreground/45" />
                    <p className="text-sm font-medium">Choose a Codex chat</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground/70">
                      Existing native Codex sessions appear here when the host is connected.
                    </p>
                  </div>
                </div>
              ) : historyState === "loading" ? (
                <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
                  <LoaderCircleIcon className="size-3.5 animate-spin" /> Loading conversation
                </div>
              ) : historyState === "error" ? (
                <div className="flex h-full items-center justify-center text-center">
                  <div className="max-w-sm text-xs text-muted-foreground">
                    <AlertCircleIcon className="mx-auto mb-2 size-4 text-destructive" />
                    {error ?? "Could not load this Codex chat."}
                    <Button
                      className="mx-auto mt-3"
                      size="xs"
                      variant="outline"
                      onClick={() => void loadHistory()}
                    >
                      Retry
                    </Button>
                  </div>
                </div>
              ) : messages.length === 0 ? (
                <div className="flex h-full items-center justify-center text-center">
                  <p className="text-xs text-muted-foreground/70">
                    This Codex chat has no messages yet.
                  </p>
                </div>
              ) : (
                <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
                  {historyCursor ? (
                    <Button
                      className="mx-auto"
                      size="xs"
                      variant="outline"
                      onClick={() => void loadOlderHistory()}
                    >
                      Load older messages
                    </Button>
                  ) : null}
                  {messages.map((message) => (
                    <MessageBubble key={message.id} message={message} />
                  ))}
                </div>
              )}
            </div>

            <div className="shrink-0 border-t border-border/65 bg-background/80 px-4 py-3 sm:px-8">
              {currentSendError ? (
                <p className="mb-2 flex items-center gap-1.5 text-xs text-destructive" role="alert">
                  <AlertCircleIcon className="size-3.5" /> {currentSendError}
                </p>
              ) : sendState ? (
                <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <p className="flex items-center gap-1.5" role="status">
                    {sendState.status === "queued" ? (
                      <LoaderCircleIcon className="size-3.5 animate-spin" />
                    ) : (
                      <CircleDashedIcon className="size-3.5" />
                    )}
                    {sendStatusLabel(sendState.status)}
                  </p>
                  {observationTimedOut && selectedThread ? (
                    <>
                      <span aria-hidden>·</span>
                      <span>Watching paused after 5 minutes.</span>
                      <Button
                        size="xs"
                        variant="ghost-muted"
                        onClick={() => {
                          setObservationTimedOut(false);
                          observeAfterSend(selectedThread.id, sendGenerationRef.current);
                        }}
                      >
                        Keep watching
                      </Button>
                    </>
                  ) : null}
                </div>
              ) : null}
              <div className="mx-auto flex w-full max-w-3xl items-end gap-2">
                <Textarea
                  value={composer}
                  onChange={(event) => setComposer(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      void handleSend();
                    }
                  }}
                  disabled={!selectedThread || sendState?.status === "queued"}
                  placeholder={
                    selectedThread ? "Message Codex…" : "Select a chat to write a message"
                  }
                  aria-label="Message Codex"
                  size="sm"
                  className="min-h-11 flex-1 resize-none"
                />
                <Button
                  size="icon"
                  aria-label="Send message"
                  disabled={
                    !selectedThread ||
                    composer.trim().length === 0 ||
                    sendState?.status === "queued"
                  }
                  onClick={() => void handleSend()}
                >
                  <SendIcon />
                </Button>
              </div>
              <p className="mx-auto mt-1.5 w-full max-w-3xl text-[10px] text-muted-foreground/55">
                Ctrl/⌘ + Enter to send
              </p>
            </div>
          </section>
        </div>
      </main>
    </SidebarInset>
  );
}
