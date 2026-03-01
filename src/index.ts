/**
 * Plugin entry point — loaded by bootstrap.js via Services.scriptloader.
 *
 * Creates the singleton Addon instance and exposes it as Zotero.ZoteroLLMAssistant.
 * Also defines the `ztoolkit` global for convenient access to zotero-plugin-toolkit APIs.
 *
 * This file runs once per Zotero session. It must be idempotent — if the global
 * already exists (e.g. after a hot reload), it reuses it.
 *
 * @module index
 */
import { BasicTool } from "zotero-plugin-toolkit";
import Addon from "./addon";
import { config } from "../package.json";

const basicTool = new BasicTool();

if (!(basicTool.getGlobal("Zotero") as any)[config.addonInstance]) {
  _globalThis.addon = new Addon();
  defineGlobal("ztoolkit", () => {
    return _globalThis.addon.data.ztoolkit;
  });
  (Zotero as any)[config.addonInstance] = _globalThis.addon;
}

function defineGlobal(name: Parameters<BasicTool["getGlobal"]>[0]): void;
function defineGlobal(name: string, getter: () => any): void;
function defineGlobal(name: string, getter?: () => any) {
  Object.defineProperty(_globalThis, name, {
    get() {
      return getter ? getter() : basicTool.getGlobal(name);
    },
  });
}
