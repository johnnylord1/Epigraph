export type SourceAccessErrorType =
  | "source-challenge"
  | "missing-source"
  | "timeout"
  | "rate-limit"
  | "network"
  | "source-error"
  | "deferred"
  | "unknown";

export interface SourceAccessClassification {
  errorType: SourceAccessErrorType;
  sourceWide: boolean;
  recoveryHint: "flaresolverr" | "webview" | "external-browser" | null;
}

export function sourceAccessErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  const serialized = String(error ?? "").trim();
  return serialized || "Unknown source error.";
}

export function isSourceChallengeMessage(message: string): boolean {
  return /cloudflare|captcha|challenge|anti.?bot|flaresolverr|bypass|checking your browser|just a moment|attention required|access denied|ddos.?guard/i.test(message);
}

export function isConfirmedAntibotChallengeMessage(message: string): boolean {
  if (/LinkageError|AbstractMethodError|NoSuchMethodError|NoSuchFieldError|IncompatibleClassChangeError|NoClassDefFoundError|ClassNotFoundException|VerifyError|UnsupportedClassVersionError|SerializationException|JsonDecodingException|MissingFieldException|source (?:is )?(?:obsolete|removed|retired)|not implemented|UnsupportedOperationException|HTTP\s*404|status\s*404|unauthori[sz]ed|login required|authentication required|invalid cookie|expired cookie|status\s*401|http\s*401/i.test(message)) {
    return false;
  }
  return /cloudflare|captcha|cf-chl|just a moment|checking your browser|attention required|ddos.?guard|anti.?bot(?:\s+challenge)?/i.test(message);
}

export function classifySourceAccessError(error: unknown): SourceAccessClassification {
  // Suwayomi wraps every resolver failure in "Exception while fetching data (/field) :", which says nothing about
  // the cause and would otherwise read as a network failure.
  const message = sourceAccessErrorMessage(error).replace(/Exception while fetching data \([^)]*\)\s*:?/gi, "");
  if (/timeout|timed out|abort/i.test(message)) {
    return { errorType: "timeout", sourceWide: false, recoveryHint: null };
  }
  if (/429|rate.?limit|too many requests/i.test(message)) {
    return { errorType: "rate-limit", sourceWide: true, recoveryHint: null };
  }
  if (/source.*not.*install|missing source|not installed|loader/i.test(message)) {
    return { errorType: "missing-source", sourceWide: true, recoveryHint: null };
  }
  if (isSourceChallengeMessage(message)) {
    return { errorType: "source-challenge", sourceWide: true, recoveryHint: "flaresolverr" };
  }
  if (/network|fetch|econn|dns|connection|socket|http 5|http 0/i.test(message)) {
    return { errorType: "network", sourceWide: false, recoveryHint: null };
  }
  if (/source|extension|parse|forbidden|http 4/i.test(message)) {
    return { errorType: "source-error", sourceWide: false, recoveryHint: null };
  }
  return { errorType: "unknown", sourceWide: false, recoveryHint: null };
}

export function isSourceWideAccessError(error: unknown): boolean {
  return classifySourceAccessError(error).sourceWide;
}
