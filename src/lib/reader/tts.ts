export interface TtsTextProvider {
  getSegmentCount(): number;
  getSegmentText(index: number): string;
  highlightSegment(index: number): void;
  clearHighlight(): void;
}

export interface PdfTextItemLike {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
}

export interface TtsPdfSegment {
  text: string;
  top: number;
  left: number;
  width: number;
  height: number;
}

type TtsSubscriber = () => void;

const MIN_RATE = 0.5;
const MAX_RATE = 2.5;
const DEFAULT_RATE = 1;

function getSpeechSynthesis(): SpeechSynthesis | null {
  if (typeof window === "undefined") return null;
  return window.speechSynthesis ?? null;
}

function getUtteranceConstructor(): typeof SpeechSynthesisUtterance | null {
  if (typeof window === "undefined") return null;
  return window.SpeechSynthesisUtterance ?? null;
}

function clampRate(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_RATE;
  return Math.round(Math.min(MAX_RATE, Math.max(MIN_RATE, value)) * 100) / 100;
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

export function createDomTtsTextProvider(root: HTMLElement, selector = "p, li, blockquote, h1, h2, h3, h4, h5, h6"): TtsTextProvider {
  let active: HTMLElement | null = null;
  const primary = Array.from(root.querySelectorAll<HTMLElement>(selector))
    .filter((node) => normalizeText(node.textContent).length > 0);
  const fallback = primary.length > 0
    ? primary
    : Array.from(root.querySelectorAll<HTMLElement>("div"))
      .filter((node) => normalizeText(node.textContent).length > 0);
  const nodes = fallback.length > 0 && fallback[0] !== root ? fallback : [root].filter((node) => normalizeText(node.textContent).length > 0);

  return {
    getSegmentCount() {
      return nodes.length;
    },
    getSegmentText(index: number) {
      return normalizeText(nodes[index]?.textContent);
    },
    highlightSegment(index: number) {
      active?.classList.remove("tts-active-segment");
      active = nodes[index] ?? null;
      if (!active) return;
      active.classList.add("tts-active-segment");
      active.scrollIntoView({ behavior: "smooth", block: "center" });
    },
    clearHighlight() {
      active?.classList.remove("tts-active-segment");
      active = null;
    },
  };
}

export function groupPdfTextItems(items: PdfTextItemLike[]): TtsPdfSegment[] {
  const positioned = items
    .map((item) => {
      const text = normalizeText(item.str);
      const transform = item.transform ?? [];
      const left = Number(transform[4] ?? 0);
      const baseline = Number(transform[5] ?? 0);
      const height = Math.max(1, Number((item.height ?? Math.abs(transform[3] ?? 12)) || 12));
      return {
        text,
        left,
        top: baseline - height,
        width: Math.max(1, Number(item.width ?? text.length * 7)),
        height,
      };
    })
    .filter((item) => item.text.length > 0)
    .sort((a, b) => b.top - a.top || a.left - b.left);

  const rows: TtsPdfSegment[] = [];
  for (const item of positioned) {
    const previous = rows[rows.length - 1];
    const sameLine = previous && Math.abs(previous.top - item.top) <= Math.max(previous.height, item.height) * 0.7;
    if (sameLine) {
      const right = Math.max(previous.left + previous.width, item.left + item.width);
      const bottom = Math.max(previous.top + previous.height, item.top + item.height);
      previous.text = normalizeText(`${previous.text} ${item.text}`);
      previous.left = Math.min(previous.left, item.left);
      previous.top = Math.min(previous.top, item.top);
      previous.width = right - previous.left;
      previous.height = bottom - previous.top;
    } else {
      rows.push({ ...item });
    }
  }

  return rows;
}

export function createTtsController() {
  let provider: TtsTextProvider | null = null;
  let utterance: SpeechSynthesisUtterance | null = null;
  let resumeAfterPause = false;
  const listeners = new Set<TtsSubscriber>();

  const state = {
    isPlaying: false,
    playbackRate: DEFAULT_RATE,
    selectedVoice: "",
    currentSegmentIndex: 0,
    voices: [] as SpeechSynthesisVoice[],
    hasProvider: false,
    segmentCount: 0,
    supported: typeof window !== "undefined" && !!getSpeechSynthesis() && !!getUtteranceConstructor(),
  };

  function notify() {
    state.hasProvider = !!provider;
    state.segmentCount = provider?.getSegmentCount() ?? 0;
    listeners.forEach((listener) => listener());
  }

  function loadVoices() {
    const synthesis = getSpeechSynthesis();
    state.voices = synthesis?.getVoices?.() ?? [];
    notify();
  }

  function selectVoice() {
    if (!state.selectedVoice) return null;
    return state.voices.find((voice) => voice.name === state.selectedVoice) ?? null;
  }

  function clearUtterance() {
    if (!utterance) return;
    utterance.onend = null;
    utterance.onerror = null;
    utterance = null;
  }

  function cancelSpeech(clearHighlight = true) {
    clearUtterance();
    getSpeechSynthesis()?.cancel();
    state.isPlaying = false;
    resumeAfterPause = false;
    if (clearHighlight) provider?.clearHighlight();
    notify();
  }

  function findSpeakableIndex(start: number, direction: 1 | -1): number {
    if (!provider) return -1;
    const count = provider.getSegmentCount();
    let index = Math.max(0, Math.min(count - 1, start));
    while (index >= 0 && index < count) {
      if (normalizeText(provider.getSegmentText(index)).length > 0) return index;
      index += direction;
    }
    return -1;
  }

  function speakAt(index: number) {
    const synthesis = getSpeechSynthesis();
    const Utterance = getUtteranceConstructor();
    if (!provider || !synthesis || !Utterance) {
      cancelSpeech();
      return;
    }

    const speakableIndex = findSpeakableIndex(index, 1);
    if (speakableIndex < 0) {
      cancelSpeech();
      return;
    }

    clearUtterance();
    synthesis.cancel();
    const text = normalizeText(provider.getSegmentText(speakableIndex));
    state.currentSegmentIndex = speakableIndex;
    state.isPlaying = true;
    provider.highlightSegment(speakableIndex);

    utterance = new Utterance(text);
    utterance.rate = state.playbackRate;
    utterance.voice = selectVoice();
    utterance.onend = () => {
      const nextIndex = speakableIndex + 1;
      if (provider && nextIndex < provider.getSegmentCount()) {
        speakAt(nextIndex);
        return;
      }
      cancelSpeech();
    };
    utterance.onerror = () => {
      cancelSpeech();
    };

    synthesis.speak(utterance);
    notify();
  }

  function handlePageHide() {
    cancelSpeech();
  }

  function handleVisibilityChange() {
    if (document.visibilityState === "hidden") cancelSpeech();
  }

  if (typeof window !== "undefined") {
    loadVoices();
    getSpeechSynthesis()?.addEventListener?.("voiceschanged", loadVoices);
    window.addEventListener("pagehide", handlePageHide);
    document.addEventListener("visibilitychange", handleVisibilityChange);
  }

  return {
    state,
    subscribe(listener: TtsSubscriber) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    loadVoices,
    setProvider(nextProvider: TtsTextProvider | null) {
      cancelSpeech();
      provider = nextProvider;
      state.currentSegmentIndex = 0;
      notify();
    },
    play(index = state.currentSegmentIndex) {
      const synthesis = getSpeechSynthesis();
      if (!provider || !synthesis || !state.supported) return;
      if (synthesis.paused && resumeAfterPause) {
        synthesis.resume();
        state.isPlaying = true;
        resumeAfterPause = false;
        notify();
        return;
      }
      speakAt(index);
    },
    pause() {
      const synthesis = getSpeechSynthesis();
      if (!synthesis || !state.isPlaying) return;
      synthesis.pause();
      state.isPlaying = false;
      resumeAfterPause = true;
      notify();
    },
    stop() {
      state.currentSegmentIndex = 0;
      cancelSpeech();
    },
    next() {
      if (!provider) return;
      const nextIndex = findSpeakableIndex(state.currentSegmentIndex + 1, 1);
      if (nextIndex < 0) {
        cancelSpeech();
        return;
      }
      speakAt(nextIndex);
    },
    previous() {
      if (!provider) return;
      const previousIndex = findSpeakableIndex(state.currentSegmentIndex - 1, -1);
      const target = previousIndex >= 0 ? previousIndex : 0;
      speakAt(target);
    },
    setRate(value: number) {
      state.playbackRate = clampRate(value);
      if (state.isPlaying) speakAt(state.currentSegmentIndex);
      else notify();
    },
    setVoice(name: string) {
      state.selectedVoice = name;
      if (state.isPlaying) speakAt(state.currentSegmentIndex);
      else notify();
    },
    destroy() {
      if (typeof window !== "undefined") {
        getSpeechSynthesis()?.removeEventListener?.("voiceschanged", loadVoices);
        window.removeEventListener("pagehide", handlePageHide);
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      }
      cancelSpeech();
      listeners.clear();
    },
  };
}
