import { ImagePlusIcon, LoaderCircleIcon } from "lucide-react";
import { memo, useRef, type ChangeEvent } from "react";

export function takeComposerImageFiles(input: { files: ArrayLike<File> | null; value: string }) {
  const files = Array.from(input.files ?? []);
  input.value = "";
  return files;
}

export const ComposerImagePicker = memo(function ComposerImagePicker(props: {
  busy: boolean;
  disabled: boolean;
  onFiles: (files: File[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const label = props.busy ? "Preparing images" : "Attach images";

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = takeComposerImageFiles(event.currentTarget);
    if (files.length > 0) props.onFiles(files);
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="composer-image-input"
        onChange={handleChange}
      />
      <button
        type="button"
        aria-label={label}
        aria-busy={props.busy || undefined}
        className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-secondary-label transition-colors hover:bg-accent/55 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 sm:size-8"
        disabled={props.disabled || props.busy}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => inputRef.current?.click()}
      >
        {props.busy ? (
          <LoaderCircleIcon
            aria-hidden
            className="size-4 animate-spin motion-reduce:animate-none"
          />
        ) : (
          <ImagePlusIcon aria-hidden className="size-4" />
        )}
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {props.busy ? "Preparing selected images" : ""}
      </span>
    </>
  );
});
