"use client";

import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";

import { TableHead } from "@/components/ui/table";

// Generic sortable column header shared by the cv-versions and Scouts
// tables (#89) — extracted from cv-versions' original page-local
// `SortableHead` so both tables' sort UI stays a single implementation.

export function SortableHead<Column extends string>({
  column,
  label,
  className,
  sort,
  onSort,
}: {
  column: Column;
  label: string;
  className?: string;
  sort: { column: Column; direction: "asc" | "desc" };
  onSort: (column: Column) => void;
}) {
  const active = sort.column === column;
  const ariaSort = !active ? "none" : sort.direction === "asc" ? "ascending" : "descending";
  const Icon = !active ? ArrowUpDown : sort.direction === "asc" ? ArrowUp : ArrowDown;

  return (
    <TableHead aria-sort={ariaSort} className={className}>
      <button
        type="button"
        className="inline-flex items-center gap-1 hover:text-foreground"
        onClick={() => onSort(column)}
      >
        {label}
        <Icon className="size-3.5" />
      </button>
    </TableHead>
  );
}
