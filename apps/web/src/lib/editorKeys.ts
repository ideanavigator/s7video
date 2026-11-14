// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * Regions that own their keys (S7V-101): the Editor panel and the file view. While focus is in
 * one, its shortcuts (S, Delete, Mod+Z, Mod+S) reach it and never the chat composer, and
 * returning to the window leaves focus there.
 */
export const EDITOR_KEYS_SELECTOR = "[data-editor-keys]";

export function isInEditorKeysRegion(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(EDITOR_KEYS_SELECTOR) !== null;
}
