import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { shouldRefocusComposerOnWindowFocus } from "./ChatView.logic";

it("keeps keyboard focus on a sidebar row on window return, but not a clicked row", async () => {
  const tree = document.createElement("div");
  tree.setAttribute("role", "tree");
  const row = (name: string, tabIndex: number) => {
    const element = document.createElement("div");
    element.setAttribute("role", "treeitem");
    element.tabIndex = tabIndex;
    element.textContent = name;
    tree.append(element);
    return element;
  };
  const clicked = row("Clicked thread", -1);
  const tabbed = row("Tabbed thread", 0);
  document.body.append(tree);
  using _tree = { [Symbol.dispose]: () => tree.remove() };

  await userEvent.click(clicked);
  expect(document.activeElement).toBe(clicked);
  expect(shouldRefocusComposerOnWindowFocus(document.activeElement)).toBe(true);

  await userEvent.tab();
  expect(document.activeElement).toBe(tabbed);
  expect(shouldRefocusComposerOnWindowFocus(document.activeElement)).toBe(false);
});

it("leaves focus in the Editor on window return (S7V-101)", async () => {
  const editor = document.createElement("div");
  editor.setAttribute("data-editor-keys", "");
  const timeline = document.createElement("div");
  timeline.tabIndex = -1;
  timeline.textContent = "Timeline";
  editor.append(timeline);
  const outside = document.createElement("button");
  outside.textContent = "Outside";
  document.body.append(editor, outside);
  using _editor = { [Symbol.dispose]: () => (editor.remove(), outside.remove()) };

  await userEvent.click(timeline);
  expect(document.activeElement).toBe(timeline);
  expect(shouldRefocusComposerOnWindowFocus(document.activeElement)).toBe(false);

  await userEvent.click(outside);
  expect(shouldRefocusComposerOnWindowFocus(document.activeElement)).toBe(true);
});
