// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import type { ProviderDriverKind, ServerProviderSkill } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { ComposerCommandMenu, type ComposerCommandItem } from "./ComposerCommandMenu";

const skillItem = (skill: ServerProviderSkill): ComposerCommandItem => ({
  id: `skill:claudeAgent:${skill.name}`,
  type: "skill",
  provider: "claudeAgent" as ProviderDriverKind,
  skill,
  label: skill.displayName ?? `/skill:${skill.name}`,
  description: skill.description ?? "",
});

it("shows a built-in skill's friendly name in the / menu and keeps other skills' labels", async () => {
  await using screen = await render(
    <ComposerCommandMenu
      listId="composer-menu"
      items={[
        skillItem({
          name: "video:remove-silences",
          displayName: "Remove silences",
          description: "Cut the pauses from the clip.",
          path: "/app/skills/skills/remove-silences/SKILL.md",
          scope: "system",
          enabled: true,
        }),
        skillItem({
          name: "review",
          description: "Review changes.",
          path: "/home/.claude/skills/review/SKILL.md",
          scope: "user",
          enabled: true,
        }),
      ]}
      resolvedTheme="light"
      isLoading={false}
      triggerKind="slash-command"
      activeItemId={null}
      onHighlightedItemChange={() => {}}
      onSelect={() => {}}
    />,
    { router: false },
  );

  const row = (name: string) =>
    screen.container.querySelector(`[data-composer-item-id="skill:claudeAgent:${name}"]`)
      ?.textContent;
  await expect.poll(() => row("video:remove-silences")).toMatch(/^Remove silences/u);
  expect(row("video:remove-silences")).not.toContain("/skill:");
  expect(row("review")).toMatch(/^\/skill:review/u);
});
