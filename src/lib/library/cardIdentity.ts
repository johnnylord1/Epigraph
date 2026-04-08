export function createComicLibraryCardId(mangaId: number): string {
  return `comic:${mangaId}`;
}

export function createBookLibraryCardId(bookId: string): string {
  return `book:${bookId}`;
}

export function isComicLibraryCardId(cardId: string): boolean {
  return cardId.startsWith("comic:");
}

export function isBookLibraryCardId(cardId: string): boolean {
  return cardId.startsWith("book:");
}
