import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Agents write Markdown (headings, lists, tables, code). Rendered here instead of as one flat
 * paragraph. Raw HTML in the text is never rendered (react-markdown's default), only Markdown.
 * Long text starts collapsed to about `lines` lines, with "Show all".
 */
export function Markdown({ text, lines = 12 }: { text: string; lines?: number }) {
  const [open, setOpen] = useState(false);
  const long = text.split("\n").length > lines || text.length > lines * 90;
  return (
    <div>
      <div className={`md ${long && !open ? "md-clamped" : ""}`} style={long && !open ? { maxHeight: `${lines * 1.45}em` } : undefined}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" /> }}
        >
          {text}
        </ReactMarkdown>
      </div>
      {long && (
        <button className="mt-1 text-[12px] underline" onClick={() => setOpen(!open)}>
          {open ? "Show less" : "Show all"}
        </button>
      )}
    </div>
  );
}
