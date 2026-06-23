import { writable } from "svelte/store";

export interface LibraryMotionEnvironment {
  libraryVisible: boolean;
  windowFocused: boolean;
  shellIdle: boolean;
  motionEnabled: boolean;
}

export interface LibraryMotionGateInput extends LibraryMotionEnvironment {
  panelActive: boolean;
  cardActuallyVisible: boolean;
}

export const DEFAULT_LIBRARY_MOTION_ENVIRONMENT: LibraryMotionEnvironment = {
  libraryVisible: false,
  windowFocused: true,
  shellIdle: false,
  motionEnabled: true,
};

export const libraryMotionEnvironment = writable<LibraryMotionEnvironment>(
  DEFAULT_LIBRARY_MOTION_ENVIRONMENT,
);

export function setLibraryMotionEnvironment(environment: LibraryMotionEnvironment): void {
  libraryMotionEnvironment.set(environment);
}

export function canRunLibraryMotion(input: LibraryMotionGateInput): boolean {
  return input.libraryVisible
    && input.panelActive
    && input.windowFocused
    && !input.shellIdle
    && input.cardActuallyVisible
    && input.motionEnabled;
}
