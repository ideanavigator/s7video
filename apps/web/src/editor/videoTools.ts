// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT

/** The agent's video tools (ADR-004) start with `video_`, under any MCP server prefix. */
const VIDEO_TOOL = /(?:^|__|[.:/])video_[a-z_]+$/iu;

export function isVideoToolName(toolName: string | null | undefined): boolean {
  return typeof toolName === "string" && VIDEO_TOOL.test(toolName.trim());
}
