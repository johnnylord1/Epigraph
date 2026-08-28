import { getServerAuthHeader, getServerUrl } from "./client";

export interface LibraryUpdateJobsInfo {
  isRunning: boolean;
  totalJobs: number;
  finishedJobs: number;
  skippedCategoriesCount: number;
  skippedMangasCount: number;
}

export interface LibraryUpdateMangaPatch {
  status?: string | null;
  manga?: {
    id: number;
    title?: string | null;
    thumbnailUrl?: string | null;
    unreadCount?: number | null;
    downloadCount?: number | null;
    chapters?: {
      totalCount?: number | null;
    } | null;
  } | null;
}

export interface LibraryUpdateEvent {
  jobsInfo: LibraryUpdateJobsInfo;
  mangaUpdates: LibraryUpdateMangaPatch[];
  omittedUpdates: boolean;
}

export interface LibraryUpdateSubscription {
  close: () => void;
}

const LIBRARY_UPDATE_STATUS_SUBSCRIPTION = `
  subscription EpigraphLibraryUpdateStatus($input: LibraryUpdateStatusChangedInput!) {
    libraryUpdateStatusChanged(input: $input) {
      omittedUpdates
      jobsInfo {
        isRunning
        totalJobs
        finishedJobs
        skippedCategoriesCount
        skippedMangasCount
      }
      mangaUpdates {
        status
        manga {
          id
          title
          thumbnailUrl
          unreadCount
          downloadCount
          chapters {
            totalCount
          }
        }
      }
    }
  }
`;

function websocketUrl() {
  return `${getServerUrl()}/api/graphql`.replace(/^http/i, "ws");
}

export function subscribeLibraryUpdateStatus(
  onProgress: (event: LibraryUpdateEvent) => void,
  onError?: (error: unknown) => void,
): LibraryUpdateSubscription {
  const id = `library-update-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let closed = false;
  let socket: WebSocket | null = null;

  try {
    socket = new WebSocket(websocketUrl(), "graphql-transport-ws");
  } catch (error) {
    onError?.(error);
    return { close: () => {} };
  }

  const send = (message: Record<string, unknown>) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(message));
  };

  socket.onopen = () => {
    const auth = getServerAuthHeader();
    send({
      type: "connection_init",
      payload: auth ? { Authorization: auth } : {},
    });
  };

  socket.onmessage = (event) => {
    try {
      const message = JSON.parse(String(event.data));
      if (message.type === "connection_ack") {
        send({
          id,
          type: "subscribe",
          payload: {
            query: LIBRARY_UPDATE_STATUS_SUBSCRIPTION,
            variables: { input: { maxUpdates: 40 } },
          },
        });
        return;
      }

      if (message.type === "ping") {
        send({ type: "pong" });
        return;
      }

      if (message.type === "next") {
        const update = message.payload?.data?.libraryUpdateStatusChanged;
        const jobsInfo = update?.jobsInfo;
        if (jobsInfo) {
          onProgress({
            jobsInfo,
            mangaUpdates: Array.isArray(update?.mangaUpdates) ? update.mangaUpdates : [],
            omittedUpdates: Boolean(update?.omittedUpdates),
          });
        }
        return;
      }

      if (message.type === "error") {
        onError?.(message.payload ?? message);
      }
    } catch (error) {
      onError?.(error);
    }
  };

  socket.onerror = (event) => {
    if (!closed) onError?.(event);
  };

  return {
    close: () => {
      closed = true;
      try {
        send({ id, type: "complete" });
        socket?.close();
      } catch {}
    },
  };
}
