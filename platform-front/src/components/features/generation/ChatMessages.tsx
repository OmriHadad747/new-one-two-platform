import { forwardRef } from "react";
import { ArtifactBlock } from "./ArtifactBlock";
import { ProgressTimeline } from "./ProgressTimeline";
import type { ProgressEvent } from "@/types/dashboard";

export interface ChatMessage {
  id: string;
  role: "ai" | "user";
  text: string;
  artifacts?: string[];
}

interface ChatMessagesProps {
  messages: ChatMessage[];
  isStreaming: boolean;
  streamingEvents: ProgressEvent[];
}

export const ChatMessages = forwardRef<HTMLDivElement, ChatMessagesProps>(
  ({ messages, isStreaming, streamingEvents }, ref) => (
    <div className="flex-1 overflow-y-auto px-6 py-6 flex flex-col gap-5">
      {messages.map((msg) => (
        <div key={msg.id} className="flex gap-3">
          <div
            className={`w-[30px] h-[30px] rounded-lg shrink-0 flex items-center justify-center text-[13px] font-bold select-none
              ${msg.role === "ai"
                ? "bg-gradient-to-br from-accent to-teal text-white"
                : "bg-raised border border-white/13 text-muted"
              }`}
          >
            {msg.role === "ai" ? "A" : "M"}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[11px] font-semibold text-faint mb-1.5 tracking-wide uppercase">
              {msg.role === "ai" ? "New One Two AI" : "You"}
            </div>
            <p className={`text-sm leading-relaxed ${msg.role === "user" ? "text-muted" : "text-ink"}`}>
              {msg.text}
            </p>
            {msg.artifacts && msg.artifacts.length > 0 && (
              <ArtifactBlock label="Output" files={msg.artifacts} />
            )}
          </div>
        </div>
      ))}

      {isStreaming && (
        <div className="flex gap-3">
          <div className="w-[30px] h-[30px] rounded-lg shrink-0 flex items-center justify-center text-[13px] font-bold bg-gradient-to-br from-accent to-teal text-white select-none">
            A
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[11px] font-semibold text-faint mb-1.5 tracking-wide uppercase">
              New One Two AI
            </div>
            <ProgressTimeline events={streamingEvents} isStreaming={isStreaming} />
          </div>
        </div>
      )}

      <div ref={ref} />
    </div>
  )
);
ChatMessages.displayName = "ChatMessages";
