import { describe, expect, it } from "vitest";
import { allowsNativeMenu, shouldSuppressNativeMenu } from "./nativeMenu";

/** Build a DOM fragment and hand back the node to right-click. */
function target(html: string, selector: string): Element {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host.querySelector(selector)!;
}

/** A selection covering `el`'s contents, as a right-click on selected text
 *  would have. jsdom implements Range well enough for the containment check. */
function selecting(el: Node): Selection {
  const range = document.createRange();
  range.selectNodeContents(el);
  return {
    isCollapsed: false,
    rangeCount: 1,
    getRangeAt: () => range,
  } as unknown as Selection;
}

/** Nothing selected — the state a right-click on empty space happens in. */
const NOTHING = { isCollapsed: true, rangeCount: 0 } as unknown as Selection;

describe("allowsNativeMenu", () => {
  it("keeps the page menu in editable fields — Paste and Look Up matter there", () => {
    expect(allowsNativeMenu(target("<textarea></textarea>", "textarea"))).toBe(true);
    expect(allowsNativeMenu(target("<input />", "input"))).toBe(true);
    expect(
      allowsNativeMenu(target('<div contenteditable="true"><b id="x">hi</b></div>', "#x")),
    ).toBe(true);
  });

  it("keeps it inside document content WHILE something is selected", () => {
    const el = target(
      '<div data-native-menu><article><p><em id="deep">a word</em></p></article></div>',
      "#deep",
    );
    // With a selection the WebView offers Copy, Look Up and Translate — exactly
    // what a right-click on a sentence is for.
    expect(allowsNativeMenu(el, selecting(el))).toBe(true);
  });

  it("withholds it on document content with nothing selected", () => {
    const el = target('<div data-native-menu><p id="p">a word</p></div>', "#p");
    // With nothing selected the WebView offers "Back" and "Reload" — the menu
    // of a web page, in an app that is not one. The right-click belongs to the
    // pane instead, which is why the same conversation seemed to have two
    // different menus depending on where the pointer landed.
    expect(allowsNativeMenu(el, NOTHING)).toBe(false);
  });

  it("ignores a selection made somewhere else entirely", () => {
    const elsewhere = target("<div><p id=other>other text</p></div>", "#other");
    const el = target('<div data-native-menu><p id="p">a word</p></div>', "#p");
    expect(allowsNativeMenu(el, selecting(elsewhere))).toBe(false);
  });

  it("withholds it on chrome — a sidebar row is a link only incidentally", () => {
    // What the user hit: right-clicking a session offered "Open Link in New
    // Window" and "Download Linked File".
    const row = target('<aside><a href="/live/s1" id="row">a session</a></aside>', "#row");
    expect(allowsNativeMenu(row)).toBe(false);
  });

  it("withholds it on a Screen tab, whose name used to get selected", () => {
    const tab = target('<div class="tabs"><span id="tab">Screen 1</span></div>', "#tab");
    expect(allowsNativeMenu(tab)).toBe(false);
  });

  it("handles a text node target and a missing target without throwing", () => {
    const p = target("<div data-native-menu><p id=t>words</p></div>", "#t");
    expect(allowsNativeMenu(p.firstChild, selecting(p))).toBe(true); // the text node
    expect(allowsNativeMenu(null)).toBe(false);
    expect(allowsNativeMenu(window)).toBe(false);
  });

  it("treats a read-only contenteditable as chrome, not a field", () => {
    const el = target('<div contenteditable="false"><span id="x">x</span></div>', "#x");
    expect(allowsNativeMenu(el)).toBe(false);
  });
});

describe("shouldSuppressNativeMenu", () => {
  it("stands down once a component has handled the right-click", () => {
    // Radix opens its menu AND preventDefaults. Suppressing on top of that is
    // harmless, but doing it FIRST makes Radix skip its own handler — which
    // left sessions, projects and Screen tabs with no menu at all.
    const chrome = target('<div><span id="c">Screen 1</span></div>', "#c");
    expect(shouldSuppressNativeMenu({ target: chrome, defaultPrevented: true })).toBe(false);
    expect(shouldSuppressNativeMenu({ target: chrome, defaultPrevented: false })).toBe(true);
  });

  it("never suppresses inside a field — Paste matters with nothing selected", () => {
    const field = target("<textarea></textarea>", "textarea");
    expect(shouldSuppressNativeMenu({ target: field, defaultPrevented: false })).toBe(false);
  });

  it("suppresses on document content with nothing selected, so the pane menu opens", () => {
    const doc = target('<div data-native-menu><p id="d">text</p></div>', "#d");
    expect(shouldSuppressNativeMenu({ target: doc, defaultPrevented: false })).toBe(true);
  });
});
