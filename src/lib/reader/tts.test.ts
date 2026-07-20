import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDomTtsTextProvider,
  createTtsController,
  groupPdfTextItems,
  type TtsTextProvider,
} from "./tts";

class MockUtterance {
  text: string;
  rate = 1;
  voice: SpeechSynthesisVoice | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(text: string) {
    this.text = text;
  }
}

function createProvider(segments: string[]): TtsTextProvider & { highlighted: number[]; cleared: number } {
  return {
    highlighted: [],
    cleared: 0,
    getSegmentCount() {
      return segments.length;
    },
    getSegmentText(index: number) {
      return segments[index] ?? "";
    },
    highlightSegment(index: number) {
      this.highlighted.push(index);
    },
    clearHighlight() {
      this.cleared += 1;
    },
  };
}

describe("tts controller", () => {
  let spoken: MockUtterance[];
  let voices: SpeechSynthesisVoice[];
  let synthesis: Partial<SpeechSynthesis>;

  beforeEach(() => {
    spoken = [];
    let paused = false;
    voices = [
      { name: "A", lang: "en-US" } as SpeechSynthesisVoice,
      { name: "B", lang: "pt-BR" } as SpeechSynthesisVoice,
    ];
    synthesis = {
      get paused() {
        return paused;
      },
      getVoices: vi.fn(() => voices),
      speak: vi.fn((utterance: SpeechSynthesisUtterance) => {
        spoken.push(utterance as unknown as MockUtterance);
      }),
      cancel: vi.fn(),
      pause: vi.fn(() => {
        paused = true;
      }),
      resume: vi.fn(() => {
        paused = false;
      }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };

    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: synthesis,
    });
    Object.defineProperty(window, "SpeechSynthesisUtterance", {
      configurable: true,
      value: MockUtterance,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads voices and selects a voice by name", () => {
    const tts = createTtsController();
    const provider = createProvider(["Hello"]);

    tts.setProvider(provider);
    tts.setVoice("B");
    tts.play();

    expect(tts.state.voices.map((voice) => voice.name)).toEqual(["A", "B"]);
    expect(spoken[0]?.voice?.name).toBe("B");
    tts.destroy();
  });

  it("speaks sequential segments and skips empty text", () => {
    const tts = createTtsController();
    const provider = createProvider(["First", " ", "Second"]);

    tts.setProvider(provider);
    tts.play();
    expect(spoken[0]?.text).toBe("First");
    spoken[0]?.onend?.();

    expect(spoken[1]?.text).toBe("Second");
    expect(provider.highlighted).toEqual([0, 2]);
    tts.destroy();
  });

  it("clamps playback rate and restarts the current segment while speaking", () => {
    const tts = createTtsController();
    const provider = createProvider(["First"]);

    tts.setProvider(provider);
    tts.play();
    tts.setRate(9);

    expect(tts.state.playbackRate).toBe(2.5);
    expect(spoken).toHaveLength(2);
    expect(spoken[1]?.rate).toBe(2.5);
    tts.destroy();
  });

  it("stops speech and clears highlight", () => {
    const tts = createTtsController();
    const provider = createProvider(["First"]);

    tts.setProvider(provider);
    tts.play();
    tts.stop();

    expect(tts.state.isPlaying).toBe(false);
    expect(tts.state.currentSegmentIndex).toBe(0);
    expect(provider.cleared).toBeGreaterThan(0);
    expect(synthesis.cancel).toHaveBeenCalled();
    tts.destroy();
  });

  it("cancels speech when the page is hidden or unloaded", () => {
    const tts = createTtsController();
    const provider = createProvider(["First"]);

    tts.setProvider(provider);
    tts.play();
    window.dispatchEvent(new Event("pagehide"));

    expect(tts.state.isPlaying).toBe(false);
    expect(provider.cleared).toBeGreaterThan(0);
    expect(synthesis.cancel).toHaveBeenCalled();
    tts.destroy();
  });
});

describe("tts extraction helpers", () => {
  it("extracts and highlights DOM paragraph segments", () => {
    document.body.innerHTML = "<article><p>One</p><p>Two</p></article>";
    const root = document.querySelector("article");
    expect(root).not.toBeNull();
    if (!root) return;
    root.querySelectorAll("p").forEach((node) => {
      node.scrollIntoView = vi.fn();
    });

    const provider = createDomTtsTextProvider(root);
    provider.highlightSegment(1);

    expect(provider.getSegmentCount()).toBe(2);
    expect(provider.getSegmentText(1)).toBe("Two");
    expect(root.querySelectorAll(".tts-active-segment")).toHaveLength(1);
  });

  it("groups PDF text items into readable line segments", () => {
    const segments = groupPdfTextItems([
      { str: "Hello", transform: [1, 0, 0, 12, 10, 100], width: 30, height: 12 },
      { str: "world", transform: [1, 0, 0, 12, 46, 100], width: 32, height: 12 },
      { str: "Next", transform: [1, 0, 0, 12, 10, 80], width: 30, height: 12 },
    ]);

    expect(segments.map((segment) => segment.text)).toEqual(["Hello world", "Next"]);
  });
});
