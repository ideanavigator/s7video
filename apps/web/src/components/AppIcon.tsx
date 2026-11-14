// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT

/** This build's icon: `icons:export` and `apply-web-brand-assets` put the channel's touch icon here. */
export const APP_ICON_URL = "/apple-touch-icon.png";

export function AppIcon(props: { readonly className?: string }) {
  return <img src={APP_ICON_URL} alt="" className={props.className} />;
}
