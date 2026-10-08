import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Chat — AI asszisztens" },
      { name: "description", content: "AI chat alkalmazás a tencent/hy4-preview-free modellel." },
      { property: "og:title", content: "Chat — AI asszisztens" },
      { property: "og:description", content: "AI chat alkalmazás a tencent/hy4-preview-free modellel." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  beforeLoad: () => {
    throw redirect({ href: "/chat.html" });
  },
  component: () => null,
});
