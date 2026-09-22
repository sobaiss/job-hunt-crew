import { cn } from "@/lib/utils";

// The white sheet a CVVersion's rendition is shown on. `CvMarkdownContent`
// deliberately owns none of this chrome — it styles the document's insides
// and leaves the surrounding "page" to its callers — but the three surfaces
// that display a CV (the Import screen, the edit page's read view and the CV
// panel's preview) had each written their own frame, and the three had
// already drifted apart in padding and shadow. This is that frame, once.
//
// It is sized as a real sheet rather than as a web column: 210mm is A4's
// width and 15mm a document's side margins, so on a wide screen a CV reads
// as a page instead of as text stretched across the window. Anything
// narrower than the sheet — a phone, or the CV panel on a small screen —
// falls back to the width it actually has.

// A container holding a sheet is sized as the sheet plus that container's own
// padding, so its heading, metadata and actions line up with the CV's edges
// instead of floating wider than it. The padding differs per surface, hence
// one constant each.

/** The page column, for the routes that are just the CV: sheet plus `p-8`. */
export const CV_PAGE_COLUMN_CLASS = "max-w-[calc(210mm_+_4rem)]";

/**
 * The slide-over column: the sheet plus `SheetContent`'s own `p-6`. The `sm:`
 * prefix is load-bearing — a right-hand `SheetContent` defaults to
 * `sm:max-w-sm`, which an unprefixed max-width would lose to at that
 * breakpoint. Below `sm` the panel stays full-width, as it already did.
 */
export const CV_PANEL_COLUMN_CLASS = "sm:max-w-[calc(210mm_+_3rem)]";

export function CvPaper({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="cv-paper"
      className={cn(
        "mx-auto w-[210mm] max-w-full rounded-md border border-border bg-white p-[15mm] text-sm text-foreground shadow-sm",
        className,
      )}
      {...props}
    />
  );
}
