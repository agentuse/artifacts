import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { fetchArtifact } from "../api";
import type { ArtifactType } from "../types";

export function Tile(props: { artifactId: string; type: ArtifactType }) {
  if (props.type === "html") {
    // The iframe loads /api/render/:id directly. The server attaches CSP
    // there; sandbox="allow-scripts" (no allow-same-origin) keeps the iframe
    // in an opaque origin so its scripts cannot reach the parent viewer.
    return (
      <div className="tile-body html">
        <iframe
          sandbox="allow-scripts"
          src={`/api/render/${props.artifactId}`}
          title="artifact"
        />
      </div>
    );
  }
  if (props.type === "pdf") {
    // Firefox renders PDFs via PDF.js (a real JS app), so the iframe needs
    // allow-scripts. Withholding allow-same-origin keeps it in an opaque
    // origin, isolated from the viewer DOM.
    return (
      <div className="tile-body pdf">
        <iframe
          sandbox="allow-scripts"
          src={`/api/artifact/${props.artifactId}`}
          title="artifact"
        />
      </div>
    );
  }
  if (props.type === "png" || props.type === "jpg" || props.type === "webp") {
    return (
      <div className="tile-body image">
        <img src={`/api/artifact/${props.artifactId}`} alt="artifact" />
      </div>
    );
  }
  return <MarkdownTile artifactId={props.artifactId} />;
}

function MarkdownTile(props: { artifactId: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setContent(null);
    setError(null);
    fetchArtifact(props.artifactId)
      .then((c) => {
        if (alive) setContent(c);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [props.artifactId]);

  if (error) return <div className="tile-body">error: {error}</div>;
  if (content == null) return <div className="tile-body">loading…</div>;
  return (
    <div className="tile-body markdown-body">
      <div className="markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
          {content}
        </ReactMarkdown>
      </div>
    </div>
  );
}
