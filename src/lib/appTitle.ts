/** Window title for the main window. Development builds say so, so they are never mistaken for the installed app. */
export function mainWindowTitle(targetTitle: string, dev: boolean = import.meta.env.DEV): string {
  return `Epigraph${dev ? " DEV" : ""} [${targetTitle}]`;
}
