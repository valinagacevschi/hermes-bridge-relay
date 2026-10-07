// Generated from expo-hermes; edit the private source, not this mirror.
import { config } from "dotenv";
import Redis from "ioredis";
import { requireApiKey } from "@/lib/auth";

config({ override: true });

export async function GET(request: Request): Promise<Response> {
  const profile_id = new URL(request.url).pathname.split("/").at(-1)!;

  const authErr = await requireApiKey(request, profile_id);
  if (authErr) return authErr;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const sub = new Redis(process.env.REDIS_URL!);
      // See server/http.ts — an unhandled ioredis "error" event crashes the process.
      sub.on("error", (err) => console.error("[relay-stream] redis error:", err));

      sub.subscribe(`hermes:${profile_id}:out`);
      sub.on("message", (_, msg) => {
        controller.enqueue(encoder.encode(`data: ${msg}\n\n`));
      });

      const heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(": ping\n\n"));
      }, 15_000);

      request.signal.addEventListener("abort", () => {
        clearInterval(heartbeat);
        sub.unsubscribe().then(() => sub.quit());
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
