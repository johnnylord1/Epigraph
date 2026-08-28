import { invoke } from "@tauri-apps/api/core";

export type MediaAuditPayload = {
  event: string;
  [key: string]: unknown;
};

type MediaAuditWindow = Window & {
  __epigraphMediaAudit?: boolean;
};

export function mediaAuditEnabled(): boolean {
  return typeof window !== "undefined" && Boolean((window as MediaAuditWindow).__epigraphMediaAudit);
}

export function traceMediaAudit(event: MediaAuditPayload): void {
  if (!mediaAuditEnabled()) return;
  void invoke("record_media_audit_event", { event: JSON.stringify(event) }).catch(() => {});
}
