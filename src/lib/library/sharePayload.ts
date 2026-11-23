/**
 * What the library Share action produces from the selected works: a list of titles linked to
 * their pages, and the layout of an image with their covers and names.
 *
 * The list uses chat markdown that Discord renders: `- [Title](<url>)`. The angle brackets keep
 * Discord from adding a large preview for every link; the cover image already shows the works.
 */

export interface ShareWork {
  title: string;
  /** The work's page at its source. Anything other than an http(s) address is left out. */
  url?: string | null;
}

export interface ShareCollageLayout {
  columns: number;
  rows: number;
  /** Works drawn with their cover. */
  covers: number;
  /** Works left out of the image; the last cell says how many when this is above zero. */
  overflow: number;
}

/** The image stays readable in a chat preview; the list always carries every work. */
export const SHARE_COLLAGE_MAX_CELLS = 40;
const MAX_COLUMNS = 8;
/** A cell is a 2:3 cover plus two lines of title. */
const CELL_ASPECT = 1 / 1.78;
/** Chat previews show a landscape image best. */
const TARGET_IMAGE_ASPECT = 1.3;

export function shareableUrl(url: string | null | undefined): string | null {
  const value = url?.trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function cleanTitle(title: string) {
  return title.replace(/\s+/g, " ").trim();
}

/** Escapes what would end a markdown link label early or format the title. */
export function escapeShareTitle(title: string) {
  return cleanTitle(title).replace(/([\\[\]*_~`|<>])/g, "\\$1");
}

export function buildShareText(works: readonly ShareWork[]): string {
  return works
    .filter((work) => cleanTitle(work.title))
    .map((work) => {
      const title = escapeShareTitle(work.title);
      const url = shareableUrl(work.url);
      return url ? `- [${title}](<${url}>)` : `- ${title}`;
    })
    .join("\n");
}

export function shareCollageLayout(count: number, maxCells = SHARE_COLLAGE_MAX_CELLS): ShareCollageLayout {
  const total = Math.max(0, Math.floor(count));
  if (total === 0) return { columns: 0, rows: 0, covers: 0, overflow: 0 };
  const cells = Math.min(total, Math.max(1, maxCells));
  const covers = total > cells ? cells - 1 : cells;
  const overflow = total - covers;

  let best = { columns: 1, rows: cells, score: Number.POSITIVE_INFINITY };
  for (let columns = 1; columns <= Math.min(cells, MAX_COLUMNS); columns += 1) {
    const rows = Math.ceil(cells / columns);
    const empty = rows * columns - cells;
    const aspect = (columns * CELL_ASPECT) / rows;
    const score = Math.abs(Math.log(aspect / TARGET_IMAGE_ASPECT)) + empty * 0.35;
    if (score < best.score) best = { columns, rows, score };
  }
  return { columns: best.columns, rows: best.rows, covers, overflow };
}
