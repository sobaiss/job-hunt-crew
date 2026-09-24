"use client";

import { ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// A multi-select filter behind one trigger, on the ColumnVisibilityMenu's
// pattern: a checkbox item prevents its own `onSelect` so ticking one value
// doesn't close the menu before another can be ticked, while "Tout effacer"
// is a one-shot action and closes it like any menu item.
//
// A dropdown rather than a row of checkboxes because the Analyses table's
// Statut filter is one of only two that stay out of the "Plus de filtres"
// fold: six checkboxes laid flat there would push the table below the fold,
// which is the problem that fold was introduced to solve.

export function CheckboxFilterMenu<Value extends string>({
  id,
  labelId,
  emptyLabel,
  values,
  selected,
  onChange,
  valueLabel,
  clearLabel,
  countLabel,
}: {
  id: string;
  /** The visible `<Label>` above the trigger. Read out before the trigger's
   *  own text, so the accessible name is "Statut, À postuler" — the filter
   *  and its current value, which neither alone gives. */
  labelId: string;
  /** Shown on the trigger while nothing is selected: "Tous les statuts",
   *  same wording the single-select's "no filter" option carried. */
  emptyLabel: string;
  values: readonly Value[];
  selected: readonly Value[];
  onChange: (selected: Value[]) => void;
  valueLabel: (value: Value) => string;
  clearLabel: string;
  /** Shown on the trigger from two selections up — a single one names itself
   *  instead, which is both shorter and more informative. */
  countLabel: (count: number) => string;
}) {
  const toggle = (value: Value) => {
    onChange(
      selected.includes(value)
        ? selected.filter((v) => v !== value)
        : [...selected, value],
    );
  };

  const triggerLabel =
    selected.length === 0
      ? emptyLabel
      : selected.length === 1
        ? valueLabel(selected[0]!)
        : countLabel(selected.length);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          id={id}
          // The visible <Label> then the current value, so the name reads
          // "Statut, À postuler". It points at the inner span rather than at
          // the button itself: a self-reference is dropped by the accessible
          // name computation, which would leave the value unannounced.
          aria-labelledby={`${labelId} ${id}-value`}
          variant="outline"
          size="sm"
          // Full width and left-aligned so it lines up with the Input and the
          // native selects it sits beside in the filter bar.
          className="h-9 w-full justify-between font-normal"
        >
          <span id={`${id}-value`}>{triggerLabel}</span>
          <ChevronDown aria-hidden="true" className="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {values.map((value) => (
          <DropdownMenuCheckboxItem
            key={value}
            checked={selected.includes(value)}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={() => toggle(value)}
          >
            {valueLabel(value)}
          </DropdownMenuCheckboxItem>
        ))}
        {selected.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onChange([])}>
              {clearLabel}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
