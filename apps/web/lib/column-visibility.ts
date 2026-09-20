// Pure, framework-free column-visibility state (#129), reused as-is by
// Analyses, CV versions, and Agents (#130/#131). A `hideable: false` column
// (a table's primary column, plus any selection/action/link column a page
// keeps out of the model entirely) never enters the state — only hideable
// columns are tracked, and they default to visible unless `defaultVisible`
// says otherwise (e.g. an id column hidden by default).

export type ColumnConfig<Key extends string> = {
  key: Key;
  labelKey: string;
  hideable: boolean;
  className?: string;
  defaultVisible?: boolean;
};

export type ColumnVisibilityState<Key extends string> = Partial<
  Record<Key, boolean>
>;

export function defaultColumnVisibility<Key extends string>(
  columns: readonly ColumnConfig<Key>[],
): ColumnVisibilityState<Key> {
  const state: ColumnVisibilityState<Key> = {};
  for (const column of columns) {
    if (column.hideable) state[column.key] = column.defaultVisible ?? true;
  }
  return state;
}

export function toggleColumn<Key extends string>(
  state: ColumnVisibilityState<Key>,
  key: Key,
): ColumnVisibilityState<Key> {
  return { ...state, [key]: !state[key] };
}

export function resetColumnVisibility<Key extends string>(
  columns: readonly ColumnConfig<Key>[],
): ColumnVisibilityState<Key> {
  return defaultColumnVisibility(columns);
}
