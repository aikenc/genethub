import { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * An agent's reply, rendered as the markdown it is.
 *
 * It was plain text until now, which meant every list arrived as a wall of
 * hyphens, every table as pipes, and every code block indistinguishable from
 * prose — while `web-workbench.md` §2 had been promising markdown rendering all
 * along.
 *
 * No raw HTML: `react-markdown` ignores it unless a plugin is added, and none is.
 * That is not a detail to leave to chance here — this text comes from a model,
 * which means it can be steered by anything the model read, including a file in
 * the repository it was told to summarise.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="space-y-2 break-words text-fg" data-testid="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="whitespace-pre-wrap">{children}</p>,
          h1: ({ children }) => <h1 className="mt-1 text-base font-medium">{children}</h1>,
          h2: ({ children }) => <h2 className="mt-1 text-sm font-medium">{children}</h2>,
          h3: ({ children }) => <h3 className="mt-1 text-sm font-medium">{children}</h3>,
          ul: ({ children }) => <ul className="ml-4 list-disc space-y-1">{children}</ul>,
          ol: ({ children }) => <ol className="ml-4 list-decimal space-y-1">{children}</ol>,
          li: ({ children }) => <li className="pl-0.5">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-line pl-3 text-muted">{children}</blockquote>
          ),
          hr: () => <hr className="border-line" />,
          strong: ({ children }) => <strong className="font-medium text-fg">{children}</strong>,
          a: ({ href, children }) => (
            // Somewhere else entirely: this is a link a model wrote, and it opens
            // in its own tab rather than replacing the workbench.
            <a
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              className="text-accent underline underline-offset-2"
            >
              {children}
            </a>
          ),
          code: ({ className, children }) => {
            const text = String(children).replace(/\n$/, "");
            // `react-markdown` gives fenced blocks a `language-*` class and
            // inline spans none, which is the only thing that tells them apart.
            if (!className?.startsWith("language-") && !text.includes("\n")) {
              return (
                <code className="rounded bg-raised px-1 py-0.5 font-mono text-[0.9em]">
                  {text}
                </code>
              );
            }
            return <Code text={text} language={className?.replace("language-", "")} />;
          },
          pre: ({ children }) => <>{children}</>,
          table: ({ children }) => (
            <div className="max-w-full overflow-x-auto touch-pan-x">
              <table className="w-full border-collapse text-xs">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-line bg-raised px-2 py-1 text-left font-medium">
              {children}
            </th>
          ),
          td: ({ children }) => <td className="border border-line px-2 py-1">{children}</td>,
          img: ({ src, alt }) => (
            <img src={src} alt={alt} className="max-h-80 rounded-md border border-line" />
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

/**
 * A fenced code block, with the one control that turns out to matter: getting it
 * out of here and into an editor.
 */
function Code({ text, language }: { text: string; language?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="min-w-0 max-w-full overflow-hidden rounded-md border border-line bg-raised">
      <div className="flex items-center justify-between gap-2 border-b border-line px-2 py-1">
        <span className="font-mono text-[11px] text-faint">{language || "code"}</span>
        <button
          type="button"
          className="text-[11px] text-accent"
          onClick={() => {
            void navigator.clipboard?.writeText(text);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre className="max-h-96 max-w-full overflow-x-auto whitespace-pre-wrap break-all px-2 py-1.5 font-mono text-xs leading-relaxed text-fg">
        <code>{text}</code>
      </pre>
    </div>
  );
}
