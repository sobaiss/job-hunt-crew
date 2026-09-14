"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { useScouts, type ScoutStatus } from "@/hooks/use-scouts";
import { useCvVersions } from "@/hooks/use-cv-versions";
import {
  DEFAULT_SCOUTS_SORT,
  sortScouts,
  type ScoutsSortColumn,
  type ScoutsSortState,
} from "@/lib/scouts-sort";
import { SortableHead } from "@/components/sortable-head";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const COLUMNS: { key: ScoutsSortColumn; labelKey: string; className?: string }[] = [
  { key: "label", labelKey: "list.columns.label" },
  { key: "status", labelKey: "list.columns.status" },
  { key: "baseCv", labelKey: "list.columns.baseCv" },
  { key: "sites", labelKey: "list.columns.sites" },
  { key: "lastRun", labelKey: "list.columns.lastRun" },
  { key: "relevantFinds", labelKey: "list.columns.relevantFinds", className: "text-right" },
];

function statusVariant(
  status: ScoutStatus,
): "secondary" | "success" | "destructive" | "warning" {
  if (status === "ACTIVE") return "success";
  if (status === "PAUSED") return "warning";
  return "secondary";
}

export default function ScoutsPage() {
  const t = useTranslations("scouts");
  const { data: scouts, isPending, isError } = useScouts();
  const { data: cvVersions } = useCvVersions();
  const [sort, setSort] = useState<ScoutsSortState>(DEFAULT_SCOUTS_SORT);

  const toggleSort = (column: ScoutsSortColumn) => {
    setSort((current) =>
      current.column === column
        ? { column, direction: current.direction === "asc" ? "desc" : "asc" }
        : { column, direction: "asc" },
    );
  };

  const cvLabelById = new Map(cvVersions?.map((cv) => [cv.id, cv.label]));
  const cvLabel = (id: string) => cvLabelById.get(id) ?? id;

  // Sorting (#89) is applied client-side to the full list, same shape as
  // `sortCvVersions` on the cv-versions table.
  const sortedScouts = scouts ? sortScouts(scouts, sort, cvLabelById) : undefined;

  return (
    <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-8 p-8">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-serif text-2xl font-semibold">{t("title")}</h1>
          <p className="text-sm text-muted">{t("list.subtitle")}</p>
        </div>
        <Button asChild className="shrink-0">
          <Link href="/scouts/new">{t("list.new")}</Link>
        </Button>
      </div>

      {isPending && (
        <div
          role="status"
          aria-label={t("list.loading")}
          className="flex flex-col gap-3"
        >
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      )}

      {isError && (
        <p role="alert" className="text-sm text-destructive">
          {t("list.loadError")}
        </p>
      )}

      {sortedScouts && sortedScouts.length === 0 && (
        <p className="text-sm text-muted">{t("list.empty")}</p>
      )}

      {sortedScouts && sortedScouts.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              {COLUMNS.map((column) => (
                <SortableHead
                  key={column.key}
                  column={column.key}
                  label={t(column.labelKey)}
                  className={column.className}
                  sort={sort}
                  onSort={toggleSort}
                />
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedScouts.map((scout) => (
              <TableRow key={scout.id}>
                <TableCell className="font-medium">
                  <Link
                    href={`/scouts/${scout.id}`}
                    className="text-accent underline-offset-2 hover:underline"
                  >
                    {scout.label}
                  </Link>
                </TableCell>
                <TableCell>
                  <Badge variant={statusVariant(scout.status)}>
                    {t(`status.${scout.status}`)}
                  </Badge>
                </TableCell>
                <TableCell>{cvLabel(scout.cvVersionId)}</TableCell>
                <TableCell>
                  {t("list.sites", { count: scout.targetSiteKeys.length })}
                </TableCell>
                <TableCell>
                  {scout.lastRunAt
                    ? new Date(scout.lastRunAt).toLocaleDateString()
                    : t("list.neverRun")}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {scout.relevantFindsCount}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </main>
  );
}
