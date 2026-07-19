import type { DesktopApi } from "./shared.js";

declare global {
  interface Window {
    desktop: DesktopApi;
  }
}

export {};
