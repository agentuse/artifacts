import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { fetchArtifact } from "../api";

export function Tile(props: { artifactId: string; type: "markdown" | "html" }) {
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

  if (error) {
    return <div className="tile-body">error: {error}</div>;
  }
  if (content == null) {
    return <div className="tile-body">loading…</div>;
  }
  if (props.type === "html") {
    // Server has already injected meta-CSP and stripped meta-refresh / base /
    // preload-rel <link>. We pile sandbox="" on top so even if scrubbing fails
    // open, the iframe still cannot run scripts, navigate top, or read same-origin.
    return (
      <div className="tile-body html">
        <iframe sandbox="" srcDoc={content} title="artifact" />
      </div>
    );
  }
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
