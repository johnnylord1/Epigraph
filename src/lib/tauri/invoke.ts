import { invoke as tauriInvoke, type InvokeArgs, type InvokeOptions } from "@tauri-apps/api/core";

// Application commands are accepted only from the main webview. A detached reader window installs a relay
// here so the few commands its reader needs travel through the main window instead. The relay returns null
// for a command it does not handle, which then goes to Tauri as usual.
type InvokeRelay = (cmd: string, args: InvokeArgs | undefined) => Promise<unknown> | null;

let relay: InvokeRelay | null = null;

export function setInvokeRelay(next: InvokeRelay | null) {
  relay = next;
}

export function invoke<T>(cmd: string, ...rest: [args?: InvokeArgs, options?: InvokeOptions]): Promise<T> {
  const relayed = relay?.(cmd, rest[0]);
  if (relayed) return relayed as Promise<T>;
  return tauriInvoke<T>(cmd, ...rest);
}
