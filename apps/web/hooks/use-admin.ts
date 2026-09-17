"use client";

import { useQuery } from "@tanstack/react-query";

import { bff } from "@/lib/bff-client";

// Backs the bare Admin area landing page (issue #138) — confirms the
// session's Plan actually cleared services/api's `require_admin` end to end.
export type AdminMe = { userId: string; plan: string };

export function useAdminMe() {
  return useQuery({
    queryKey: ["admin-me"],
    queryFn: () => bff.get<AdminMe>("/admin/me"),
  });
}
