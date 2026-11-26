const MARKERS = ["\u001B[?2026h", "\u001B[?2026l"] as const;
const LONGEST_PARTIAL_MARKER = Math.max(...MARKERS.map((marker) => marker.length)) - 1;

type WriteCallback = (error?: Error | null) => void;

function withoutMarkers(text: string): string {
  let rest = text;

  for (const marker of MARKERS) {
    rest = rest.replaceAll(marker, "");
  }

  return rest;
}

function partialMarkerLength(text: string): number {
  for (let length = Math.min(text.length, LONGEST_PARTIAL_MARKER); length > 0; length--) {
    const tail = text.slice(-length);

    if (MARKERS.some((marker) => marker.startsWith(tail))) {
      return length;
    }
  }

  return 0;
}

export type SynchronizedOutputStripper = {
  readonly strip: (chunk: string) => string;
  readonly flush: () => string;
};

export function synchronizedOutputStripper(): SynchronizedOutputStripper {
  let carry = "";

  return {
    strip: (chunk) => {
      const text = withoutMarkers(carry + chunk);
      const held = partialMarkerLength(text);
      carry = text.slice(text.length - held);

      return text.slice(0, text.length - held);
    },
    flush: () => {
      const rest = carry;
      carry = "";

      return rest;
    },
  };
}

export function stripSynchronizedOutput(stream: Pick<NodeJS.WriteStream, "write">): void {
  const original = stream.write.bind(stream);
  const stripper = synchronizedOutputStripper();
  let releaseScheduled = false;

  const forward = (
    data: Uint8Array | string,
    encodingOrCallback?: BufferEncoding | WriteCallback,
    callback?: WriteCallback,
  ): boolean =>
    typeof encodingOrCallback === "function"
      ? original(data, encodingOrCallback)
      : original(data, encodingOrCallback, callback);

  const release = (): void => {
    releaseScheduled = false;
    const rest = stripper.flush();

    if (rest !== "") {
      original(rest);
    }
  };

  stream.write = (
    chunk: Uint8Array | string,
    encodingOrCallback?: BufferEncoding | WriteCallback,
    callback?: WriteCallback,
  ): boolean => {
    if (typeof chunk !== "string") {
      release();

      return forward(chunk, encodingOrCallback, callback);
    }

    if (!releaseScheduled) {
      releaseScheduled = true;
      setImmediate(release);
    }

    return forward(stripper.strip(chunk), encodingOrCallback, callback);
  };
}
