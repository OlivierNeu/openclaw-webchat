// Renders a `file` content part produced by convertMessage from the bridge's
// `media {items}` events (kind:"media") and from kind:"file" parts. The data URL
// is a resolved Convex storage URL (server-side ctx.storage.getUrl); the browser
// never receives a storageId-to-path mapping or a filesystem path.
//
// Audio is rendered with a native <audio> player so OpenClaw TTS output is
// playable inline. Images render inline; everything else becomes a download
// link. assistant-ui routes `file` content parts to this component.

interface FileContentPartProps {
  part: {
    type: "file";
    mimeType?: string;
    data: string; // resolved URL
    filename?: string;
  };
}

export function MediaPart({ part }: FileContentPartProps) {
  const mime = part.mimeType ?? "";
  const url = part.data;
  const name = part.filename ?? "attachment";

  if (mime.startsWith("audio/")) {
    return (
      <div className="oc-media oc-media--audio">
        {/* TTS playback for OpenClaw audio output. */}
        <audio controls preload="metadata" src={url} className="oc-media__audio">
          <a href={url} download={name}>
            Download audio
          </a>
        </audio>
        <span className="oc-media__name">{name}</span>
      </div>
    );
  }

  if (mime.startsWith("image/")) {
    return (
      <figure className="oc-media oc-media--image">
        <img src={url} alt={name} className="oc-media__img" loading="lazy" />
        <figcaption className="oc-media__name">{name}</figcaption>
      </figure>
    );
  }

  if (mime.startsWith("video/")) {
    return (
      <div className="oc-media oc-media--video">
        <video controls preload="metadata" src={url} className="oc-media__video" />
        <span className="oc-media__name">{name}</span>
      </div>
    );
  }

  return (
    <a className="oc-media oc-media--file" href={url} download={name}>
      <span className="oc-media__icon" aria-hidden>
        ⬇
      </span>
      <span className="oc-media__name">{name}</span>
    </a>
  );
}
