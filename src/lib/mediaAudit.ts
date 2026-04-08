import { invoke } from "@tauri-apps/api/core";

export type MediaAuditPayload = {
  event: string;
  [key: string]: unknown;
};

type MediaAuditWindow = Window & {
  __aethonMediaAudit?: boolean;
};

export function mediaAuditEnabled(): boolean {
  return typeof window !== "undefined" && Boolean((window as MediaAuditWindow).__aethonMediaAudit);
}

export function traceMediaAudit(event: MediaAuditPayload): void {
  if (!mediaAuditEnabled()) return;
  void invoke("record_media_audit_event", { event: JSON.stringify(event) }).catch(() => {});
}
