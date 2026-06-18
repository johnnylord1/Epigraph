import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TtsControls from "./TtsControls.svelte";
import { createTtsController, type TtsTextProvider } from "../../lib/reader/tts";

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

const provider: TtsTextProvider = {
  getSegmentCount: () => 1,
  getSegmentText: () => "Readable text",
  highlightSegment: vi.fn(),
  clearHighlight: vi.fn(),
};

describe("TtsControls", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
        clear: () => values.clear(),
      },
    });
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: {
        paused: false,
        getVoices: vi.fn(() => []),
        speak: vi.fn(),
        cancel: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
    Object.defineProperty(window, "SpeechSynthesisUtterance", {
      configurable: true,
      value: MockUtterance,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("updates the visible speed label while the slider changes", async () => {
    const controller = createTtsController();
    controller.setProvider(provider);

    render(TtsControls, { props: { controller } });

    expect(screen.getByText("1.0x")).not.toBeNull();

    await fireEvent.input(screen.getByLabelText("Playback speed"), {
      target: { value: "1.7" },
    });

    await waitFor(() => {
      expect(screen.getByText("1.7x")).not.toBeNull();
    });

    controller.destroy();
  });

  it("restores voice and playback speed after remounting", async () => {
    const voice = { name: "Microsoft Maria", lang: "pt-BR" } as SpeechSynthesisVoice;
    vi.mocked(window.speechSynthesis.getVoices).mockReturnValue([voice]);
    const firstController = createTtsController();
    firstController.setProvider(provider);

    const first = render(TtsControls, { props: { controller: firstController } });
    await fireEvent.input(screen.getByLabelText("Playback speed"), {
      target: { value: "1.6" },
    });
    await fireEvent.change(screen.getByLabelText("Speech voice"), {
      target: { value: "Microsoft Maria" },
    });
    first.unmount();
    firstController.destroy();

    const secondController = createTtsController();
    secondController.setProvider(provider);
    render(TtsControls, { props: { controller: secondController } });

    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>("Playback speed").value).toBe("1.6");
      expect(screen.getByLabelText<HTMLSelectElement>("Speech voice").value).toBe("Microsoft Maria");
    });

    secondController.destroy();
  });
});
