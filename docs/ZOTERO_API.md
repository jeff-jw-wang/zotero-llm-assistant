# Zotero API Usage

This document covers every Zotero JS API used by the plugin, including undocumented or
version-specific ones, spike outcomes, and known gaps.

## Plugin Registration

### `Zotero.ItemPaneManager.registerSection(options)`

**Used in**: `src/modules/ui/readerPanel.ts:registerReaderPanel()`
**Availability**: Zotero 7.0+, confirmed working on 8.x
**Documentation**: Unofficial; discoverable via `Zotero.ItemPaneManager` in the console

Registers a collapsible section in the item pane (right sidebar). In reader mode, this
appears as a tab in the PDF reader's sidebar.

Key options used:

| Option | Value | Notes |
|--------|-------|-------|
| `paneID` | `"llm-assistant"` | Must be unique across all plugins |
| `pluginID` | `config.addonID` | Plugin's addon ID from manifest |
| `bodyXHTML` | inline XHTML string | Rendered inside the section body |
| `onItemChange` | callback | Called when selected item changes |
| `onRender` | callback | Called to render/re-render the section |

**`onItemChange` — enabling only in reader mode**:
```javascript
onItemChange: ({ item, setEnabled, tabType }) => {
  setEnabled(tabType === "reader"); // "reader" = PDF viewer tab
  return true;
}
```
`tabType` values: `"reader"` (PDF viewer), `"library"` (main library view), others.

**`body` element**:
The `body` passed to `onInit` and `onRender` is the container for the `bodyXHTML` content.
Use `body.ownerDocument` to get the document (it is always non-null at render time, but
TypeScript types it as `Document | null` — use `!` assertion).

---

## Preferences

### `Zotero.Prefs.get(key, global?)`
### `Zotero.Prefs.set(key, value, global?)`

**Used in**: `src/prefs.ts`
**Availability**: All Zotero versions

All plugin prefs are namespaced under `extensions.zotero.zotero-llm-assistant.*`.
The `global: true` parameter bypasses the branch prefix used in some contexts.

Default values are defined in `addon/prefs.js` (processed by zotero-plugin-scaffold at build
time to strip the prefix).

---

## Full-Text Content (PDF Extraction)

### `Zotero.FullText.getIndexedState(item)`
### `Zotero.FullText.indexItems([itemId], { complete })`
### `Zotero.FullText.getItemContent(itemId)`  ← **undocumented**

**Used in**: `src/modules/rag/extractor.ts`
**Availability**: Zotero 7+; `getItemContent` is undocumented but stable in 7.x and 8.x

`getItemContent` returns an object like:
```javascript
{
  content: string,   // full text, pages separated by \f (form feed)
  pages: number,     // number of pages Zotero indexed
}
```

### Spike S1 — pdfjs-dist bundling

**Status**: Not attempted. Using `Zotero.FullText` (Path B) instead.

**Rationale**: `Zotero.FullText.getItemContent()` is simpler, more reliable (no bundling
concerns), and already present in Zotero's own indexing pipeline. The downside is it
requires Zotero to have indexed the PDF first. `indexItems()` is called to trigger indexing
when needed.

**If `getItemContent` breaks in a future Zotero version**: implement Path A using
`pdfjs-dist` v4. The extractor interface (`extractPDF` → `{ pages, totalPages }`) is
designed so the internal extraction method can be swapped without changing callers.

### `Zotero.FullText.INDEX_STATE_UNINDEXED`

Constant: `0`. Used to check whether a PDF has been indexed before requesting content.

---

## PDF Reader Navigation

### `Zotero.Reader.getByTabID(tabID)`

**Used in**: `src/modules/ui/readerPanel.ts:openPDFAtPage()`
**Availability**: Zotero 7+

Returns a reader instance for the given tab ID, or `null` if not found.

### `reader.navigate(location)`

**Used in**: `src/modules/ui/readerPanel.ts:openPDFAtPage()`
**Availability**: Zotero 7+; typed as `navigate(location: Location)` in zotero-types

The `Location` type in zotero-types does not include `pageNumber`. In practice,
`{ pageNumber: N }` works for jumping to a specific PDF page. Used with `as any` cast.

### Spike S4 — Page navigation reliability

**Status**: Not yet validated on all platforms.

`reader.navigate({ pageNumber: page })` is the primary approach. The fallback is:
```javascript
win?.ZoteroPane?.loadURI?.(`zotero://open-pdf?page=${page}`);
```

**Update this section** after testing on macOS, Windows, and Linux. Known issues:
- On some builds, `pageNumber` may be 1-indexed or 0-indexed depending on Zotero version
- The deep link fallback may open a new reader window instead of navigating in-place

---

## Main Window

### `Zotero.getMainWindow()`
### `Zotero.getMainWindows()`

**Used in**: `src/hooks.ts`, `src/modules/ui/readerPanel.ts`
**Availability**: Zotero 7+

`getMainWindow()` returns the current focused main window.
`getMainWindows()` returns all open main windows (array). Used to attach to already-open
windows during hot-reload startup.

The return type is `Window` in the JS API but `_ZoteroTypes.MainWindow` in the TypeScript
types. Use `as _ZoteroTypes.MainWindow` when passing to typed functions.

### `mainWin.Zotero_Tabs.selectedID`

**Used in**: `src/modules/ui/readerPanel.ts:openPDFAtPage()`
**Availability**: Zotero 7+; not in type definitions — accessed via `as any`

Returns the tab ID of the currently selected tab. Used to find the active PDF reader.

---

## Localization

### `win.MozXULElement.insertFTLIfNeeded(path)`

**Used in**: `src/hooks.ts:onMainWindowLoad()`
**Availability**: Zotero 7+ (Firefox/Gecko runtime)

Loads a Fluent (FTL) localization file into the window. Files are served via the plugin's
chrome URI. The path must match a file registered in the chrome manifest.

---

## IndexedDB — Spike S2 Outcome

### Spike S2 — IndexedDB cross-context sharing

**Status**: Used in Phase A from the reader panel context. Cross-context sharing with a
hypothetical background worker has not been tested.

**Assumption used**: `globalThis.indexedDB` is accessible from the reader panel body
context (a `<browser>` element loaded from the Zotero chrome origin). If this fails, the
fallback is `Zotero.DB.queryAsync()` (Zotero's own SQLite).

**If IndexedDB is not available** in the reader panel context:
1. Migrate `conversations` and `privacy` stores to Zotero.DB with custom SQL tables
2. Keep the same public API in `db.ts` (same function signatures)
3. Document the schema in `docs/STORAGE.md`

---

## Version Compatibility

| API | Min version | Notes |
|-----|------------|-------|
| `Zotero.ItemPaneManager.registerSection` | 7.0 | Not available in Zotero 6 |
| `Zotero.FullText.getItemContent` | 7.0 | Undocumented; tested on 7.x and 8.x |
| `Zotero.Reader.getByTabID` | 7.0 | |
| `Zotero.PreferencePanes.register` | 7.0 | Used indirectly via zotero-plugin-scaffold |

The `manifest.json` declares `strict_min_version: "6.999"` (i.e., Zotero 7.0+) and
`strict_max_version: "8.*"`. Zotero 6 is not supported.

### Zotero 8.0 compatibility

Zotero 8.0 was released while this plugin was in development. No breaking API changes were
identified. The manifest's `strict_max_version: "8.*"` covers all 8.x releases.

If future Zotero versions introduce breaking changes:
- Check `Zotero.ItemPaneManager` API (most likely to change)
- Check `reader.navigate()` argument format
- Update `strict_max_version` and test with the new version

---

## Undocumented APIs — Risk Assessment

| API | Risk | Mitigation |
|-----|------|-----------|
| `Zotero.FullText.getItemContent` | Medium — could be removed | Fallback: bundle pdfjs-dist (Spike S1) |
| `reader.navigate({ pageNumber })` | Low — format could change | Fallback: `zotero://open-pdf?page=N` deep link |
| `mainWin.Zotero_Tabs.selectedID` | Low — property name could change | Null-safe access; graceful fallback |
| `win.MozXULElement.insertFTLIfNeeded` | Low — stable across Gecko versions | No fallback needed; FTL is standard |
