import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Agents write Markdown (headings, lists, tables, code). Rendered here instead of as one flat
 * paragraph. Raw HTML in the text is never rendered (react-markdown's default), only Markdown.
 * Long text starts collapsed to about `lines` lines, with "Show all".
 */
/** "[image: <path>]" of an image in ~/.fleet/uploads → the URL Fleet serves it at (other paths stay text). */
const IMAGE = /\[image: [^\]\n]*\/([0-9a-f]{16}\.(?:png|jpg|webp|gif))\]/g;
export const imageUrls = (text: string) => [...text.matchAll(IMAGE)].map((m) => `/api/hq/uploads/${m[1]}`);

/** The images in a message being written, small, under its box. */
export function DraftImages({ text }: { text: string }) {
  const urls = imageUrls(text);
  if (!urls.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5 bg-cream px-2 pb-1">
      {urls.map((u) => (
        <img key={u} src={u} alt="Pasted image" className="h-12 max-w-[96px] border-2 border-ink object-cover" />
      ))}
    </div>
  );
}

export function Markdown({ text, lines = 12 }: { text: string; lines?: number }) {
  const [open, setOpen] = useState(false);
  const long = text.split("\n").length > lines || text.length > lines * 90;
  return (
    <div>
      <div className={`md ${long && !open ? "md-clamped" : ""}`} style={long && !open ? { maxHeight: `${lines * 1.45}em` } : undefined}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
            img: ({ node: _node, ...props }) => (
              <a href={props.src} target="_blank" rel="noreferrer">
                <img {...props} className="my-1 max-h-[320px] max-w-full border-2 border-ink" />
              </a>
            ),
          }}
        >
          {text.replace(IMAGE, (_m, name: string) => `![image](/api/hq/uploads/${name})`)}
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
