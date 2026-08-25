import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

// PRD Section 8.5 step 2.
const POSTED_WITHIN_VALUES = ["24h", "7d", "14d", "30d", "any"] as const;
const REMOTE_VALUES = ["onsite", "hybrid", "remote"] as const;

// PRD Section 13 default.
const DEFAULT_MAX_OFFERS = 25;

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);

  // Mode 1 (SINGLE_URL) and Mode 2 (LISTING_URL) have no trigger endpoint yet
  // (see M3-T6 note); this endpoint currently only supports Mode 3.
  if (body?.mode !== "SITE_SEARCH") {
    return NextResponse.json({ error: "mode must be SITE_SEARCH" }, { status: 400 });
  }

  const siteConfigId = optionalString(body?.siteConfigId);
  if (!siteConfigId) {
    return NextResponse.json({ error: "siteConfigId is required" }, { status: 400 });
  }

  const siteConfig = await prisma.siteConfig.findUnique({ where: { id: siteConfigId } });
  if (!siteConfig || !siteConfig.enabled) {
    return NextResponse.json({ error: "Unknown or disabled siteConfigId" }, { status: 400 });
  }

  const postedWithin = optionalString(body?.filters?.postedWithin);
  if (
    postedWithin !== undefined &&
    !POSTED_WITHIN_VALUES.includes(postedWithin as (typeof POSTED_WITHIN_VALUES)[number])
  ) {
    return NextResponse.json(
      { error: `filters.postedWithin must be one of: ${POSTED_WITHIN_VALUES.join(", ")}` },
      { status: 400 },
    );
  }

  const remote = optionalString(body?.filters?.remote);
  if (remote !== undefined && !REMOTE_VALUES.includes(remote as (typeof REMOTE_VALUES)[number])) {
    return NextResponse.json(
      { error: `filters.remote must be one of: ${REMOTE_VALUES.join(", ")}` },
      { status: 400 },
    );
  }

  const filters = {
    keywords: optionalString(body?.filters?.keywords),
    location: optionalString(body?.filters?.location),
    postedWithin,
    contractType: optionalString(body?.filters?.contractType),
    remote,
    experienceLevel: optionalString(body?.filters?.experienceLevel),
  };

  const ingestionJob = await prisma.ingestionJob.create({
    data: {
      userId: session.user.id,
      mode: "SITE_SEARCH",
      siteConfigId,
      filters,
      maxOffers: DEFAULT_MAX_OFFERS,
      status: "PENDING",
    },
  });

  return NextResponse.json({ ingestionJob }, { status: 201 });
}
