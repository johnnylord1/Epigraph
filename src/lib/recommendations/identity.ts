import { normalizeToken } from "./normalization";
import type {
  RecommendationCandidate,
  RecommendationContentType,
  RecommendationProviderSignal,
} from "./types";

export type RecommendationContentFamily = "comic" | "prose";

export function recommendationContentFamily(contentType: RecommendationContentType): RecommendationContentFamily {
  return contentType === "novel" || contentType === "book" ? "prose" : "comic";
}

export function recommendationTitleKey(title: string, contentType: RecommendationContentType): string {
  return `${recommendationContentFamily(contentType)}:${normalizeToken(title)}`;
}

export function recommendationCandidateTitleKeys(candidate: RecommendationCandidate): string[] {
  const titles = [candidate.title, ...(candidate.alternativeTitles ?? [])]
    .map((title) => recommendationTitleKey(title, candidate.contentType))
    .filter((key) => !key.endsWith(":"));
  return [...new Set(titles)];
}

export function recommendationCandidateIdentityKeys(candidate: RecommendationCandidate): string[] {
  const providerKeys = candidate.providers
    .map((provider) => recommendationProviderRemoteKey(provider))
    .filter((key): key is string => Boolean(key));
  const candidateId = candidate.id.trim().toLowerCase();
  const idKey = candidateId ? [`candidate:${candidateId}`] : [];
  return [...new Set([
    ...recommendationCandidateTitleKeys(candidate),
    ...providerKeys,
    ...idKey,
  ])];
}

export function recommendationTrackerRemoteKey(
  providerId: string | number | null | undefined,
  remoteId: string | number | null | undefined,
): string | null {
  const provider = String(providerId ?? "").trim();
  const remote = String(remoteId ?? "").trim();
  if (!provider || !remote) return null;
  return `tracker:${provider}:${remote}`.toLowerCase();
}

export function recommendationProviderRemoteKey(provider: RecommendationProviderSignal): string | null {
  if (provider.kind !== "tracker") return null;
  return recommendationTrackerRemoteKey(provider.providerId, provider.remoteId);
}
