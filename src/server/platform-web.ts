import type { AppPlatform, FileDialogOpts, PlatformWindow, WindowFrame } from "../shared/platform";

const defaultFrame: WindowFrame = {
  height: 900,
  width: 1440,
  x: 0,
  y: 0,
};

const webWindow: PlatformWindow = {
  getFrame: () => defaultFrame,
  isMaximized: () => false,
  maximize: () => undefined,
  minimize: () => undefined,
  setFrame: () => undefined,
  show: () => undefined,
  toggleMacOSZoom: () => false,
  unmaximize: () => undefined,
};

export const createWebPlatform = (): AppPlatform => ({
  getMainWindow: () => webWindow,
  openExternal: () => undefined,
  pickFolder: (_opts?: FileDialogOpts) => Promise.resolve(null),
  quit: () => undefined,
  setMacOSVibrancy: () => false,
  showItemInFolder: () => undefined,
  syncMacOSChromeFromSettings: () => undefined,
});
