import { describe, expect, it } from "vitest";
import { readSseData } from "./chat-stream";

describe("incremental SSE", () => {
  it("handles UTF-8, CRLF, comments, partial frames and trailing data", async () => {
    const bytes = new TextEncoder().encode(': ping\r\n\r\ndata: {"text":"árvíz"}\r\n\r\ndata: [DONE]');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    });
    const frames = [];
    for await (const data of readSseData(body)) frames.push(data);
    expect(frames).toEqual(['{"text":"árvíz"}', '[DONE]']);
  });

  it("yields a delta before the upstream stream closes", async () => {
    let upstream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({ start(controller) { upstream = controller; } });
    const iterator = readSseData(body);
    upstream?.enqueue(new TextEncoder().encode('data: {"delta":"first"}\n\n'));
    expect(await iterator.next()).toEqual({ value: '{"delta":"first"}', done: false });
    upstream?.close();
    expect((await iterator.next()).done).toBe(true);
  });
});