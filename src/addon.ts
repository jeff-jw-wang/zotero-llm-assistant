/**
 * Addon class — singleton holding plugin state, lifecycle hooks, and public APIs.
 *
 * Created once in src/index.ts and stored as Zotero.ZoteroLLMAssistant.
 * The `data` field holds runtime state; `hooks` delegates to src/hooks.ts.
 *
 * @module addon
 */
import { config } from "../package.json";
import hooks from "./hooks";
import { createZToolkit } from "./utils/ztoolkit";

class Addon {
  public data: {
    alive: boolean;
    config: typeof config;
    env: "development" | "production";
    initialized?: boolean;
    ztoolkit: ZToolkit;
  };

  public hooks: typeof hooks;
  public api: object;

  constructor() {
    this.data = {
      alive: true,
      config,
      env: __env__,
      initialized: false,
      ztoolkit: createZToolkit(),
    };
    this.hooks = hooks;
    this.api = {};
  }
}

export default Addon;
