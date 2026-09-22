"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";

// Shared `react-markdown` styling for a CVVersion's Markdown rendition,
// rendered as a real formatted document — real headings, lists and tables —
// rather than a wall of `#`/`-` characters. Extracted so the CV-versions edit
// page's read-only view and the CV panel's preview render a CV's content the
// same way instead of drifting apart. This styles the document's insides
// only: the sheet around it — its A4 width, margins, border and background —
// is `CvPaper`, and a caller that needs a scroll box adds it there.

const CV_MARKDOWN_COMPONENTS: Components = {
  h1: ({ ...props }) => <h1 className="text-xl font-semibold" {...props} />,
  h2: ({ ...props }) => <h2 className="mt-4 text-lg font-semibold" {...props} />,
  h3: ({ ...props }) => <h3 className="mt-3 text-base font-semibold" {...props} />,
  p: ({ ...props }) => <p className="mt-2 leading-relaxed" {...props} />,
  ul: ({ ...props }) => <ul className="mt-2 list-disc pl-5" {...props} />,
  ol: ({ ...props }) => <ol className="mt-2 list-decimal pl-5" {...props} />,
  li: ({ ...props }) => <li className="mt-1" {...props} />,
  a: ({ ...props }) => (
    <a className="text-accent underline" target="_blank" rel="noreferrer" {...props} />
  ),
  table: ({ ...props }) => (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full border-collapse text-sm" {...props} />
    </div>
  ),
  th: ({ ...props }) => (
    <th className="border border-border bg-muted/30 px-2 py-1 text-left" {...props} />
  ),
  td: ({ ...props }) => <td className="border border-border px-2 py-1" {...props} />,
  hr: ({ ...props }) => <hr className="mt-4 border-border" {...props} />,
};

export function CvMarkdownContent({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={CV_MARKDOWN_COMPONENTS}>
      {content}
    </ReactMarkdown>
  );
}
