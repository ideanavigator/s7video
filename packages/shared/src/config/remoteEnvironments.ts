import { BRAND } from "./brand.ts";

/**
 * SSH environments, SSH device hosts and the WSL backend are off (PO decision, S7V-003 review).
 * Their scripts still use upstream `~/.t3` paths on the target, which on this Mac or any host
 * with T3 Code installed would reach T3 Code's data and server. S7V-018 removes them.
 */
export const REMOTE_ENVIRONMENTS_ENABLED = false;

export const REMOTE_ENVIRONMENTS_DISABLED_MESSAGE = `SSH, device-host and WSL environments are turned off in ${BRAND.app.productName}.`;
