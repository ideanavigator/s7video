<!--
SPDX-FileCopyrightText: 2026 s7video contributors
SPDX-License-Identifier: MIT
-->

# Security policy

## Reporting a vulnerability

Please report security problems privately. Do not open a public issue, pull request or discussion.

Email [shashwatusa7@gmail.com](mailto:shashwatusa7@gmail.com) with "s7video security" in the
subject.

GitHub's private vulnerability reporting (the **Security** tab's **Report a vulnerability** button)
is coming with S7V-010; it is not switched on yet. Until then, email is the only private channel.

Include what you found, the steps to reproduce it, the version or commit you tested, and the impact
you expect. Do not include real API keys, client footage or other people's data; describe them or use
made-up values.

## What happens next

| Step             | Target                                                           |
| ---------------- | ---------------------------------------------------------------- |
| Acknowledgement  | Within 72 hours                                                  |
| First assessment | Within 7 days: whether we accept the report and how severe it is |
| Fix and advisory | As fast as severity allows; we agree a disclosure date with you  |

We credit reporters in the advisory unless you ask us not to. Please give us a reasonable chance to
ship a fix before disclosing publicly.

## Supported versions

s7video is pre-alpha and has no releases yet. Security fixes go to the `main` branch only.

| Version                | Supported |
| ---------------------- | --------- |
| `main` (latest commit) | Yes       |
| Anything older         | No        |

Once releases start, the latest minor release will receive security fixes, and this table will be
updated.

## Scope

In scope: the s7video desktop app, its local server, the build and release scripts in this
repository, and anything that could leak API keys, local files or project media off the user's
machine.

Out of scope: vulnerabilities in T3 Code that do not affect s7video (report those to
[T3 Code](https://github.com/pingdotgg/t3code) directly), in third-party agent CLIs such as Claude Code
or Codex, and in services s7video does not run.

## Safe harbour

We will not take legal action against good-faith research that follows this policy, avoids privacy
violations and data destruction, and only tests against your own installation and data.
