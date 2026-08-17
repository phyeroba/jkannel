import * as React from 'react';

export interface DataTableColumn {
  key: string;
  label: string;
  /** Right-align figures; they are tabular by default. */
  align?: 'left' | 'right';
  /** Render the cell in JetBrains Mono (IDs, MSISDNs, references). */
  mono?: boolean;
}

/**
 * Server-side console grid.
 * @startingPoint section="Data" subtitle="Grid with mono IDs, status cells and empty state" viewport="700x300"
 */
export interface DataTableProps {
  columns: DataTableColumn[];
  rows: Array<Record<string, React.ReactNode> & { id?: string }>;
  /** Honest empty copy — "No alert instances recorded." */
  empty?: string;
  renderCell?: (column: DataTableColumn, row: Record<string, unknown>) => React.ReactNode;
}
export declare function DataTable(props: DataTableProps): JSX.Element;
