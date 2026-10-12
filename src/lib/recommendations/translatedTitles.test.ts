import { describe, expect, it } from "vitest";
import { areCognates, haveSameWords, isTranslatedTitle, titleCognates } from "./translatedTitles";

describe("titles across languages", () => {
  it("pairs words that are the same word in two languages", () => {
    expect(areCognates("lorde", "lord")).toBe(true);
    expect(areCognates("misterios", "mysteries")).toBe(true);
    expect(areCognates("trono", "throne")).toBe(true);
    expect(areCognates("mecanico", "mechanic")).toBe(true);
    expect(areCognates("lendario", "legendary")).toBe(true);
    expect(areCognates("escravo", "slave")).toBe(false);
    expect(areCognates("sombras", "shadow")).toBe(false);
  });

  it("reads a Portuguese title as the translation of its English one, and not of another work", () => {
    expect(isTranslatedTitle("Lorde dos Mistérios", "Lord of Mysteries")).toBe(true);
    expect(isTranslatedTitle("O Lendário Mecânico", "The Legendary Mechanic")).toBe(true);
    expect(isTranslatedTitle("Trono do Deus Arcanista", "Throne of Magical Arcana")).toBe(true);
    expect(isTranslatedTitle(
      "Isekai Apocalypse Mynoghra ~ Conquistando o Mundo com a Civilização mais Difícil ~",
      "Apocalypse Bringer Mynoghra",
    )).toBe(true);
    expect(isTranslatedTitle("Trono do Deus Arcanista", "Lord of Mysteries")).toBe(false);
    expect(isTranslatedTitle("Escravo das Sombras", "Shadow Slave")).toBe(false);
    expect(titleCognates("Lorde dos Mistérios", "Circle of Inevitability").pairs).toBe(0);
    expect(haveSameWords("Lord of Mysteries", "Lord of the Mysteries")).toBe(true);
    expect(haveSameWords("Shadow Slave", "Shadow Slave Academy")).toBe(false);
    expect(haveSameWords("Lord of Mysteries", "Lord of Mysteries 2")).toBe(false);
  });

});
