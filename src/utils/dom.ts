/**
 * DOM helpers for Zotero's XUL document environment.
 *
 * In Zotero 7/8, the main window and reader panels live inside XUL documents.
 * Calling `doc.createElement("div")` in a XUL document creates a XUL element,
 * NOT an HTML element — which causes `innerHTML` with HTML content to fail and
 * produces elements without standard HTML properties (`.value`, `.checked`, etc.).
 *
 * HTML elements (div, p, span, input, button, a, etc.) must be created via
 * `doc.createElementNS()` with the XHTML namespace. This module provides a
 * short helper `h()` that wraps `createElementNS` so all UI code can use
 * `h(doc, "div")` instead of the verbose full call.
 *
 * Additionally, any `innerHTML` assignments in Zotero's XUL/XML context must
 * use well-formed XHTML (self-closing void elements like `<br/>`, boolean
 * attributes with values like `checked="checked"`), because the XML fragment
 * parser is strict.
 *
 * @module utils/dom
 */

/** The XHTML namespace URI, required for creating HTML elements in XUL documents. */
const XHTML_NS = "http://www.w3.org/1999/xhtml";

/**
 * Creates an HTML element in the XHTML namespace.
 *
 * Use this instead of `doc.createElement()` in all Zotero panel/sidebar code,
 * where `doc` is typically `body.ownerDocument` (a XUL document).
 *
 * @example
 * ```typescript
 * import { h } from "../../utils/dom";
 *
 * const div = h(doc, "div");
 * const input = h(doc, "input") as HTMLInputElement;
 * const btn = h(doc, "button") as HTMLButtonElement;
 * ```
 *
 * @param doc - The ownerDocument (typically a XUL document).
 * @param tag - HTML tag name (e.g., "div", "input", "button").
 * @returns An HTMLElement in the XHTML namespace.
 */
export function h(doc: Document, tag: string): HTMLElement {
  return doc.createElementNS(XHTML_NS, tag) as HTMLElement;
}
