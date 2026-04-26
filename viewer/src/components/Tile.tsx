import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { fetchArtifact } from "../api";

export function Tile(props: { artifactId: string; type: "markdown" | "html" }) {
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
    <div className="tile-body">
      <div className="markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
          {content}
        </ReactMarkdown>
      </div>
    </div>
  );
}
