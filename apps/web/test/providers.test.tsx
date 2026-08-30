import { describe, expect, it } from "vitest";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "next-auth/react";

import { renderWithProviders, screen } from "./test-utils";
import { Providers } from "@/components/providers";

function Probe() {
  const session = useSession();
  const query = useQuery({ queryKey: ["probe"], queryFn: () => "ok" });
  return (
    <div>
      <span>session:{session.status}</span>
      <span>query:{query.data ?? "pending"}</span>
    </div>
  );
}

describe("Providers", () => {
  it("exposes Session and QueryClient context to descendants", async () => {
    renderWithProviders(<Probe />, { session: null });

    expect(screen.getByText("session:unauthenticated")).toBeInTheDocument();
    expect(await screen.findByText("query:ok")).toBeInTheDocument();
  });

  it("mounts the app provider stack without crashing", () => {
    renderWithProviders(
      <Providers>
        <p>content</p>
      </Providers>,
    );

    expect(screen.getByText("content")).toBeInTheDocument();
  });
});
