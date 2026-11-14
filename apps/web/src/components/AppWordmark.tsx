// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
import { BRAND } from "@t3tools/shared/brand";

import { cn } from "../lib/utils";

/** The product name from the brand config, so a white-label build shows its own name. */
export function AppWordmark(props: {
  readonly className?: string;
  readonly "aria-hidden"?: boolean;
}) {
  return (
    <span
      aria-hidden={props["aria-hidden"]}
      className={cn("font-semibold tracking-tight", props.className)}
    >
      {BRAND.app.productName}
    </span>
  );
}
