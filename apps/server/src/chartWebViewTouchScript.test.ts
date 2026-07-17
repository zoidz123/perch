import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

function chartTouchScriptSource(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const swiftPath = resolve(here, "../../ios/Perch/ChartWebView.swift");
  const swift = readFileSync(swiftPath, "utf8");
  const match = swift.match(/static let source = #"""([\s\S]*?)"""#/);
  assert.ok(match, "ChartTouchScript.source raw string exists");
  return match[1];
}

class FakeElement {
  readonly nodeType = 1;
  readonly children: FakeElement[] = [];
  readonly childNodes: FakeElement[] = [];
  readonly parentElement: FakeElement | null = null;
  readonly parentNode: FakeElement | null = null;
  readonly id = "";
  readonly style: Record<string, string> = {};
  textContent = "Revenue chart";
  innerText = "Revenue chart";

  constructor(readonly tagName: string) {}

  setAttribute() {}
  appendChild() {}
  remove() {}
  querySelector() {
    return null;
  }
  closest(selector: string) {
    if (selector === "[data-lavish-ui]") {
      return null;
    }
    if (selector.includes("div")) {
      return this;
    }
    return null;
  }
}

test("iOS chart touch script keeps mutable annotation state and handles long-press smoke path", () => {
  const source = chartTouchScriptSource();
  assert.match(source, /\blet active = true;/);
  assert.match(source, /\blet selectedEl = null;/);
  assert.match(source, /\blet selectedText = null;/);
  assert.doesNotMatch(source, /\bconst (active|selectedEl|selectedText)\b/);

  const messages: Array<Record<string, unknown>> = [];
  const listeners = new Map<string, (event: any) => void>();
  const target = new FakeElement("DIV");
  const body = new FakeElement("BODY");
  const document = {
    body,
    documentElement: new FakeElement("HTML"),
    head: new FakeElement("HEAD"),
    createElement: (tagName: string) => new FakeElement(tagName.toUpperCase()),
    elementFromPoint: () => target,
    addEventListener: (type: string, handler: (event: any) => void) => listeners.set(type, handler)
  };
  const window = {
    webkit: { messageHandlers: { perch: { postMessage: (msg: Record<string, unknown>) => messages.push(msg) } } },
    postMessage: () => {},
    addEventListener: () => {},
    scrollX: 0,
    scrollY: 0
  };

  vm.runInNewContext(source, {
    CSS: { escape: (value: string) => value },
    Element: FakeElement,
    clearTimeout,
    console,
    document,
    setTimeout: (handler: () => void) => {
      handler();
      return 1;
    },
    window
  });

  const chart = (window as any).__perchChart;
  assert.equal(typeof chart.setAnnotate, "function");
  assert.equal(typeof chart.submitNote, "function");

  assert.doesNotThrow(() => chart.setAnnotate(false));
  assert.equal(messages.at(-1)?.type, "cleared");

  chart.setAnnotate(true);
  assert.doesNotThrow(() => listeners.get("touchstart")?.({ touches: [{ clientX: 12, clientY: 18 }] }));
  const targeted = messages.at(-1);
  assert.equal(targeted?.type, "holdTargeted");
  assert.equal(targeted?.kind, "element");
  assert.equal(targeted?.tag, "div");
  assert.equal(targeted?.text, "Revenue chart");
});
