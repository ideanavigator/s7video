import { lazy, Suspense } from "react";

import { FileSurfaceLoading } from "./fileSurfaceChrome";

const PreviewImageContent = lazy(() => import("./PreviewImageContent"));

export function PreviewImage(props: {
  readonly src: string;
  readonly name: string;
  readonly mimeType?: string;
  readonly onError?: (message: string) => void;
}) {
  return (
    <Suspense fallback={<FileSurfaceLoading />}>
      <PreviewImageContent {...props} />
    </Suspense>
  );
}
