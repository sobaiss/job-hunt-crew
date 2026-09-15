import { Fragment } from "react";

// Renders a GeneratedDocument's markdownContent as real formatting instead
// of the raw `<pre>` block it used to show (issue #109, docs/adr/0009). This
// intentionally mirrors — by hand, not via a shared library — the exact
// restricted Markdown subset services/api/src/api/document_render.py's line
// classifier and `_parse_emphasis` support: `#`/`##`/`###` headings, `-`/`*`
// bullets, `**bold**`/`*italic*` inline emphasis, and a `---` rule. Anything
// outside that set renders as plain text, same as the PDF/DOCX renderers, so
// the preview never shows the candidate something richer than what they can
// actually download.

const SECTION_TYPE_COMMENT_RE = /^<!--\s*SectionType:\s*\w+\s*-->$/;
const EMPHASIS_RE = /(\*\*[^*]+?\*\*|\*[^*]+?\*)/g;

function InlineText({ text }: { text: string }) {
  const parts = text.split(EMPHASIS_RE).filter((part) => part.length > 0);
  return (
    <>
      {parts.map((part, index) => {
        if (part.startsWith("**") && part.endsWith("**")) {
          return <strong key={index}>{part.slice(2, -2)}</strong>;
        }
        if (part.startsWith("*") && part.endsWith("*")) {
          return <em key={index}>{part.slice(1, -1)}</em>;
        }
        return <Fragment key={index}>{part}</Fragment>;
      })}
    </>
  );
}

type Block =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "bullets"; items: string[] }
  | { kind: "rule" }
  | { kind: "paragraph"; text: string };

function classify(markdown: string): Block[] {
  const blocks: Block[] = [];
  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    if (!line || SECTION_TYPE_COMMENT_RE.test(line)) continue;

    if (line.startsWith("### ")) {
      blocks.push({ kind: "heading", level: 3, text: line.slice(4) });
    } else if (line.startsWith("## ")) {
      blocks.push({ kind: "heading", level: 2, text: line.slice(3) });
    } else if (line.startsWith("# ")) {
      blocks.push({ kind: "heading", level: 1, text: line.slice(2) });
    } else if (line === "---") {
      blocks.push({ kind: "rule" });
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      const item = line.slice(2);
      const last = blocks[blocks.length - 1];
      if (last?.kind === "bullets") {
        last.items.push(item);
      } else {
        blocks.push({ kind: "bullets", items: [item] });
      }
    } else {
      blocks.push({ kind: "paragraph", text: line });
    }
  }
  return blocks;
}

const HEADING_CLASS = {
  1: "text-lg font-semibold",
  2: "text-base font-semibold",
  3: "text-sm font-semibold",
} as const;

export function GeneratedDocumentPreview({ markdown }: { markdown: string | null }) {
  const blocks = classify(markdown ?? "");
  return (
    <div className="flex flex-col gap-2 text-sm text-foreground">
      {blocks.map((block, index) => {
        switch (block.kind) {
          case "heading": {
            const Tag = `h${block.level}` as const;
            return (
              <Tag key={index} className={HEADING_CLASS[block.level]}>
                <InlineText text={block.text} />
              </Tag>
            );
          }
          case "bullets":
            return (
              <ul key={index} className="list-disc pl-5">
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>
                    <InlineText text={item} />
                  </li>
                ))}
              </ul>
            );
          case "rule":
            return <hr key={index} className="border-border" />;
          case "paragraph":
            return (
              <p key={index}>
                <InlineText text={block.text} />
              </p>
            );
        }
      })}
    </div>
  );
}
