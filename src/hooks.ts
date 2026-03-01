/**
 * Lifecycle hooks — called by bootstrap.js at each plugin lifecycle event.
 *
 * onStartup:         Zotero is ready → register UI panels, prefs, notifiers.
 * onMainWindowLoad:  A main Zotero window opened → attach window-specific UI.
 * onMainWindowUnload: Window closing → cleanup window-specific registrations.
 * onShutdown:        Plugin is being disabled/uninstalled → full cleanup.
 *
 * @module hooks
 */
import { initLocale } from "./utils/locale";
import { createZToolkit } from "./utils/ztoolkit";
import { registerReaderPanel } from "./modules/ui/readerPanel";
import { registerLibraryPanel } from "./modules/ui/libraryPanel";
import { startLibraryIndexer, stopLibraryIndexer } from "./modules/library/indexer";
import { registerPrefsScripts } from "./modules/ui/settingsPane";
import { disposeEmbedder, ensureModelReady, isModelRevisionCurrent } from "./modules/rag/embedder";
import * as prefs from "./prefs";

/**
 * Called once after Zotero is fully initialized.
 * Registers all global plugin components (item pane sections, notifiers, etc.).
 */
async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();
  registerReaderPanel();
  registerLibraryPanel();
  startLibraryIndexer(); // Registers notifier only; index built lazily on first search.

  // Auto-warm embedding model if consent was previously given AND the cached
  // model matches the current pinned revision. This restores `modelReady = true`
  // across Zotero restarts so semantic search works without visiting Settings.
  // Skipped when the revision changed (plugin update) — that would trigger a
  // surprise ~25MB re-download; the user must update explicitly via Settings.
  if (prefs.isEmbeddingModelAccepted() && isModelRevisionCurrent()) {
    ensureModelReady().catch((err: any) => {
      ztoolkit.log(`Embedder auto-warm failed: ${err?.message}`);
    });
  }

  // Process any windows that are already open (e.g. after hot reload).
  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win as _ZoteroTypes.MainWindow)),
  );

  addon.data.initialized = true;
}

/**
 * Called for each main Zotero window that opens.
 */
async function onMainWindowLoad(
  win: _ZoteroTypes.MainWindow,
): Promise<void> {
  addon.data.ztoolkit = createZToolkit();
  // Load FTL localization for the main window.
  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );
}

/**
 * Called when a main Zotero window is closing.
 */
async function onMainWindowUnload(_win: Window): Promise<void> {
  ztoolkit.unregisterAll();
}

/**
 * Called when the plugin is shut down (disabled, uninstalled, or Zotero quit).
 * Must clean up all registrations and references.
 */
function onShutdown(): void {
  stopLibraryIndexer();
  disposeEmbedder(); // Release worker/pipeline resources (Phase D).
  ztoolkit.unregisterAll();
  addon.data.alive = false;
  delete (Zotero as any)[addon.data.config.addonInstance];
}

/**
 * Called when the preferences pane fires an event.
 */
async function onPrefsEvent(
  type: string,
  data: { [key: string]: any },
) {
  switch (type) {
    case "load":
      registerPrefsScripts(data.window);
      break;
    default:
      return;
  }
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onPrefsEvent,
};
