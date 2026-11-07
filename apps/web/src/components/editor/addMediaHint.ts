// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
/**
 * What to do instead of "Add media" when the app runs in a web browser (S7V-065). Only the desktop
 * app can hand the server a file's path, so picking and dropping files on the Editor are off there;
 * a clip attached to a chat message still imports, within the chat's upload limit.
 */
export const BROWSER_ADD_MEDIA_HINT =
  "Drop files into the chat, or use the desktop app to add large files.";
