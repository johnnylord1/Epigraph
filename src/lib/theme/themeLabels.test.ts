import { beforeEach, describe, expect, it } from "vitest";
import { applyAppLanguage, translate } from "../i18n/runtime";
import { BUILTIN_THEMES } from "./contract";
import { builtinThemeLabel } from "./themeLabels";

beforeEach(() => {
  applyAppLanguage("pt-BR");
});

describe("builtin theme labels", () => {
  it("follows the app language and keeps proper names", () => {
    const labels = Object.fromEntries(BUILTIN_THEMES.map((theme) => [theme.id, builtinThemeLabel(theme, translate)]));
    expect(labels).toMatchObject({ nocturne: "Nocturne", amoled: "AMOLED", dark: "Escuro", light: "Claro", "high-contrast": "Alto contraste" });
  });

  it("has a catalog message for every translated builtin theme", () => {
    for (const theme of BUILTIN_THEMES) {
      expect(builtinThemeLabel(theme, translate)).not.toMatch(/^theme_name_/);
    }
  });
});
