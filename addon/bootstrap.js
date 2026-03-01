/**
 * Zotero plugin bootstrap entry point.
 *
 * This file runs in Zotero's privileged extension context (not a web page).
 * It handles the Firefox/XULRunner addon lifecycle: install, startup, shutdown, uninstall.
 * The startup() function registers chrome content, loads the compiled TypeScript bundle,
 * and delegates to the addon's hook system.
 *
 * Based on Zotero's official Make It Red example and the zotero-plugin-template.
 * @see https://github.com/zotero/make-it-red
 * @see https://www.zotero.org/support/dev/zotero_7_for_developers
 */

var chromeHandle;
var prefPaneID = null;

function install(data, reason) {}

async function startup({ id, version, resourceURI, rootURI }, reason) {
  var aomStartup = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);
  var manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "__addonRef__", rootURI + "content/"],
  ]);

  const ctx = { rootURI };
  ctx._globalThis = ctx;

  Services.scriptloader.loadSubScript(
    `${rootURI}/content/scripts/__addonRef__.js`,
    ctx,
  );

  // Explicitly register the settings pane so it appears in
  // Zotero Settings sidebar under plugin panes.
  try {
    prefPaneID = await Zotero.PreferencePanes.register({
      pluginID: id,
      id: "__addonRef__-preferences",
      src: `${rootURI}content/preferences.xhtml`,
      label: "LLM Assistant",
      image: `${rootURI}content/icons/favicon@0.5x.png`,
    });
  } catch (e) {
    Zotero.logError(e);
  }

  await Zotero.__addonInstance__.hooks.onStartup();
}

async function onMainWindowLoad({ window }, reason) {
  await Zotero.__addonInstance__?.hooks.onMainWindowLoad(window);
}

async function onMainWindowUnload({ window }, reason) {
  await Zotero.__addonInstance__?.hooks.onMainWindowUnload(window);
}

async function shutdown({ id, version, resourceURI, rootURI }, reason) {
  if (reason === APP_SHUTDOWN) {
    return;
  }

  if (prefPaneID) {
    try {
      Zotero.PreferencePanes.unregister(prefPaneID);
    } catch (e) {
      Zotero.logError(e);
    }
    prefPaneID = null;
  }

  await Zotero.__addonInstance__?.hooks.onShutdown();

  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

async function uninstall(data, reason) {}
