import { SourceRuntimeError } from "./errors";
import type {
  SourceChapter,
  SourceItemDetails,
  SourcePage,
  SourceRuntime,
  SourceSearchItem,
} from "./types";

export interface DeterministicSourceContractInput {
  sourceId: string;
  query: string;
  expectedTitle: string;
  signal?: AbortSignal;
}

export interface DeterministicSourceContractEvidence {
  sourceId: string;
  mangaId: number;
  chapterId: number;
  pageCount: number;
  paginationObserved: boolean;
}

function contractFailure(stage: string, message: string): never {
  throw new SourceRuntimeError("RUNTIME_INCOMPATIBLE", message, {
    details: { contractStage: stage },
  });
}

function assertSearchItem(
  item: SourceSearchItem | undefined,
  input: DeterministicSourceContractInput,
): SourceSearchItem {
  if (!item) contractFailure("search", "The deterministic source returned no result.");
  if (item.sourceId !== input.sourceId || item.title !== input.expectedTitle) {
    contractFailure("search", "The deterministic source returned an unexpected identity.");
  }
  return item;
}

function assertDetails(
  details: SourceItemDetails,
  item: SourceSearchItem,
): SourceItemDetails {
  if (details.id !== item.id || details.sourceId !== item.sourceId || details.title !== item.title) {
    contractFailure("details", "Source details did not preserve the search result identity.");
  }
  return details;
}

function assertChapter(
  chapter: SourceChapter | undefined,
  mangaId: number,
): SourceChapter {
  if (!chapter || chapter.mangaId !== mangaId) {
    contractFailure("chapters", "Source chapters did not preserve the manga identity.");
  }
  return chapter;
}

function assertPages(pages: readonly SourcePage[]): readonly SourcePage[] {
  if (pages.length === 0) {
    contractFailure("pages", "The deterministic chapter returned no pages.");
  }
  if (pages.some((page, index) => page.index !== index || page.url.length === 0)) {
    contractFailure("pages", "Source pages were not decoded in deterministic order.");
  }
  return pages;
}

export async function runDeterministicSourceContract(
  runtime: SourceRuntime,
  input: DeterministicSourceContractInput,
): Promise<DeterministicSourceContractEvidence> {
  const firstPage = await runtime.search({
    sourceId: input.sourceId,
    mode: "SEARCH",
    page: 1,
    query: input.query,
    signal: input.signal,
  });
  const item = assertSearchItem(firstPage.items[0], input);

  const secondPage = await runtime.search({
    sourceId: input.sourceId,
    mode: "SEARCH",
    page: 2,
    query: input.query,
    signal: input.signal,
  });
  if (secondPage.items.some((candidate) => candidate.id === item.id)) {
    contractFailure("pagination", "Source pagination repeated an item identity.");
  }
  if (!firstPage.hasNextPage || secondPage.hasNextPage) {
    contractFailure("pagination", "Source pagination did not preserve its continuation state.");
  }

  const details = assertDetails(
    await runtime.getDetails(
      { id: item.id, sourceId: item.sourceId },
      input.signal,
    ),
    item,
  );
  const chapter = assertChapter(
    (await runtime.getChapters(
      { id: details.id, sourceId: details.sourceId },
      input.signal,
    ))[0],
    details.id,
  );
  const pages = assertPages(await runtime.getPages(
    { id: chapter.id, mangaId: chapter.mangaId },
    input.signal,
  ));

  return {
    sourceId: input.sourceId,
    mangaId: details.id,
    chapterId: chapter.id,
    pageCount: pages.length,
    paginationObserved: true,
  };
}
