"use client";

import { Columns3 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ColumnConfig } from "@/lib/column-visibility";

// "Columns" control (#129), reused as-is by Analyses, CV versions, and
// Agents. Only `hideable` columns get a checkbox — a table's always-visible
// primary column and any selection/action/link column simply aren't passed
// in. A checkbox item prevents its own `onSelect` so toggling one column
// doesn't close the menu before another can be toggled too; "Réinitialiser"
// is a one-shot action, so it closes the menu like any other menu item.
export function ColumnVisibilityMenu<Key extends string>({
  columns,
  isVisible,
  onToggle,
  onReset,
  label,
  columnLabel,
  resetLabel,
}: {
  columns: readonly ColumnConfig<Key>[];
  isVisible: (key: Key) => boolean;
  onToggle: (key: Key) => void;
  onReset: () => void;
  label: string;
  columnLabel: (labelKey: string) => string;
  resetLabel: string;
}) {
  const hideableColumns = columns.filter((column) => column.hideable);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <Columns3 className="size-4" />
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {hideableColumns.map((column) => (
          <DropdownMenuCheckboxItem
            key={column.key}
            checked={isVisible(column.key)}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={() => onToggle(column.key)}
          >
            {columnLabel(column.labelKey)}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onReset}>{resetLabel}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
